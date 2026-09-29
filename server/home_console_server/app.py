"""家庭控制台后端入口。

浏览器只和本服务通信：
- WebSocket /api/ws：推送数据来源、控制开关、HA 连接状态、自动发现的设备目录、实体状态和共用布局；接收按实体发起的控制请求。
- PUT /api/layout：保存全家共用的布局（卡片尺寸、顺序、常用设备、房间顺序）。
- /api/admin/*：4 位管理密码登录后管理 HA 地址、令牌、控制开关、数据来源、设备过滤（黑名单 / 白名单）和管理密码，查看操作记录，
  查看并开关 HA 自动化（只调用 automation.turn_on / turn_off，见 automations.py），
  启用季节规则后由本服务在 HA 中维护季节辅助元素与季节自动化（见 season.py）。
- /api/weather*：代理和风天气的城市搜索、实时天气与 7 天预报（见 weather.py）。
HA 令牌与和风天气密钥只保存在服务端，从不发给浏览器。
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

from .auth import LoginLimiter, Sessions
from .automations import DOMAIN as AUTOMATION_DOMAIN, build_automations, demo_automations
from .discovery import build_catalogue, filtered, visible_ids
from .ha import HaUpstream
from .season import HELPER_ENTITY as SEASON_HELPER, SEASONS, SeasonRules
from .store import ACCENTS, DEFAULT_HOME_TITLE, HOME_SUBTITLE_MAX, HOME_TITLE_MAX, THEMES, TILE_SCALE_MAX, TILE_SCALE_MIN, Store, hash_pin, id_list, is_pin, is_tile_scale, verify_pin
from .weather import Weather, WeatherError, normalize_host, valid_location

log = logging.getLogger("home_console_server")

SERVER_DIR = Path(__file__).resolve().parent.parent
COOKIE = "hc_admin"
EMPTY_CATALOGUE: dict[str, Any] = {"rooms": [], "entities": []}
REFRESH_DELAY = 0.5


# ---------- 服务白名单：只允许这些服务及参数，目标必须是当前页面可见的实体 ----------

def _number(low: float, high: float) -> Callable[[Any], bool]:
    return lambda value: isinstance(value, (int, float)) and not isinstance(value, bool) and low <= value <= high


def _short_text(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 40


def _rgb(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(_number(0, 255)(part) for part in value)


ALLOWED_SERVICES: dict[str, dict[str, dict[str, Callable[[Any], bool]]]] = {
    "light": {
        "turn_on": {"brightness_pct": _number(1, 100), "color_temp_kelvin": _number(1000, 12000), "rgb_color": _rgb},
        "turn_off": {},
    },
    "climate": {
        "set_hvac_mode": {"hvac_mode": _short_text},
        "set_temperature": {"temperature": _number(5, 40)},
        "set_fan_mode": {"fan_mode": _short_text},
    },
    "media_player": {
        "turn_on": {},
        "turn_off": {},
        "media_play_pause": {},
        "volume_set": {"volume_level": _number(0, 1)},
    },
}


def normalize_ha_url(value: str) -> str | None:
    value = value.strip()
    if not value:
        return ""
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/")


class ConsoleServer:
    def __init__(self, data_dir: Path) -> None:
        self.store = Store(data_dir)
        self.sessions = Sessions()
        self.limiter = LoginLimiter()
        self.clients: set[web.WebSocketResponse] = set()
        self._tasks: set[asyncio.Task[None]] = set()
        self.upstream = HaUpstream(self._on_status, self._on_states, self._on_registry)
        self.weather = Weather(lambda: (self.store.weather_key(), self.store.settings.weather_host, self.store.settings.weather_geo_host))
        # 自动发现：registries 为 HA 的区域 / 设备 / 实体注册表；discovered 为过滤前的完整目录。
        self.registries: tuple[list[Any], list[Any], list[Any]] | None = None
        self.discovered: dict[str, Any] = EMPTY_CATALOGUE
        self.known_ids: set[str] = set()
        self.visible: set[str] = set()
        self._refresh_task: asyncio.Task[None] | None = None
        self._refresh_dirty = False
        self._refresh_fetch = False
        # 演示模式下的自动化只存在内存中，重启服务后复位。
        self.demo_automations = demo_automations()
        self.season = SeasonRules(self.store, self.upstream, lambda: "控制台服务", self._broadcast_status)

    # ---------- HA 连接与自动发现 ----------

    async def reconnect(self) -> None:
        settings = self.store.settings
        await self.upstream.configure(settings.ha_url, self.store.token(), settings.data_source == "live")

    def catalogue(self) -> dict[str, Any]:
        return filtered(self.discovered, self.visible)

    async def _broadcast_status(self) -> None:
        await self.broadcast(self.status_message())

    async def _on_status(self, status: dict[str, Any]) -> None:
        if status["kind"] == "connected":
            self.schedule_refresh(fetch=True)
        elif status["kind"] in ("disabled", "unconfigured", "auth_failed"):
            self.registries = None
            self.known_ids = set()
            await self._apply_catalogue(EMPTY_CATALOGUE)
        await self.broadcast(self.status_message())

    async def _on_states(self, _states: dict[str, Any], changed: dict[str, Any]) -> None:
        # 出现从未见过的实体（新设备或首次快照）时重新发现；注册表变更另有事件触发。
        if any(state is not None and entity_id not in self.known_ids for entity_id, state in changed.items()):
            self.schedule_refresh(fetch=False)
        if SEASON_HELPER in changed:
            await self.broadcast(self.status_message())
        visible_changed = {entity_id: state for entity_id, state in changed.items() if entity_id in self.visible}
        if visible_changed:
            await self.broadcast({"type": "entities", "changed": visible_changed})

    async def _on_registry(self) -> None:
        self.schedule_refresh(fetch=True)

    def schedule_refresh(self, fetch: bool) -> None:
        """合并短时间内的多次变化，只重新发现一次。"""
        self._refresh_dirty = True
        self._refresh_fetch = self._refresh_fetch or fetch
        if self._refresh_task is None or self._refresh_task.done():
            self._refresh_task = asyncio.create_task(self._refresh_loop())

    async def _refresh_loop(self) -> None:
        while self._refresh_dirty:
            self._refresh_dirty = False
            await asyncio.sleep(REFRESH_DELAY)
            fetch, self._refresh_fetch = self._refresh_fetch, False
            if fetch or self.registries is None:
                try:
                    self.registries = (
                        await self.upstream.command({"type": "config/area_registry/list"}),
                        await self.upstream.command({"type": "config/device_registry/list"}),
                        await self.upstream.command({"type": "config/entity_registry/list"}),
                    )
                except Exception as error:  # 断线或权限不足：先按无区域信息发现，之后再重试
                    log.warning("读取 HA 注册表失败：%s", error)
            if self.upstream.status.get("kind") != "connected":
                continue
            self.known_ids = set(self.upstream.states)
            await self._apply_catalogue(build_catalogue(*(self.registries or ([], [], [])), self.upstream.states))
            # 设备（地暖 / 空调）可能变化：按需更新 HA 中的季节自动化。
            if self.store.settings.season_rules:
                self.season.schedule()

    async def _apply_catalogue(self, catalogue: dict[str, Any]) -> None:
        """更新目录并按过滤设置计算可见实体；页面目录变化时推送，新可见的实体补发状态。"""
        settings = self.store.settings
        before = self.catalogue()
        previous_visible = self.visible
        self.discovered = catalogue
        self.visible = visible_ids(catalogue, settings.filter_mode, settings.blacklist, settings.whitelist)
        after = self.catalogue()
        if after != before:
            await self.broadcast({"type": "catalogue", "catalogue": after})
        added = {entity_id: self.upstream.states[entity_id] for entity_id in self.visible - previous_visible if entity_id in self.upstream.states}
        if added:
            await self.broadcast({"type": "entities", "changed": added})

    def status_message(self) -> dict[str, Any]:
        settings = self.store.settings
        return {"type": "status", "dataSource": settings.data_source, "controlEnabled": settings.control_enabled,
                "homeTitle": settings.home_title, "homeSubtitle": settings.home_subtitle, "theme": settings.theme,
                "tileScale": settings.tile_scale, "accent": settings.accent, "season": self.season.season(),
                "ha": self.upstream.status}

    async def broadcast(self, message: dict[str, Any]) -> None:
        payload = json.dumps(message, ensure_ascii=False)
        for client in list(self.clients):
            if client.closed:
                self.clients.discard(client)
                continue
            try:
                await client.send_str(payload)
            except ConnectionError:
                self.clients.discard(client)

    # ---------- 浏览器 WebSocket ----------

    async def handle_ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self.clients.add(ws)
        try:
            await ws.send_json({"type": "hello", "layout": self.store.layout, "catalogue": self.catalogue()})
            await ws.send_json(self.status_message())
            states = {entity_id: self.upstream.states[entity_id] for entity_id in self.visible if entity_id in self.upstream.states}
            await ws.send_json({"type": "entities", "changed": states, "snapshot": True})
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    payload = json.loads(message.data)
                except json.JSONDecodeError:
                    continue
                if payload.get("type") == "ping":
                    # 页面用来确认连接仍然可用（手机锁屏后旧连接可能已失效却未关闭）。
                    await ws.send_json({"type": "pong"})
                elif payload.get("type") == "call_service":
                    task = asyncio.create_task(self._call_service(ws, payload, client_ip(request)))
                    self._tasks.add(task)
                    task.add_done_callback(self._tasks.discard)
        finally:
            self.clients.discard(ws)
        return ws

    async def _call_service(self, ws: web.WebSocketResponse, payload: dict[str, Any], ip: str) -> None:
        request_id = payload.get("id")
        entity_id = str(payload.get("entity", ""))
        service = str(payload.get("service", ""))
        data = payload.get("data") or {}
        error = self._reject_reason(entity_id, service, data)
        if error is None:
            try:
                await self.upstream.call_service(entity_id.split(".")[0], service, entity_id, data)
            except Exception as exc:  # HA 返回失败、超时或断线
                error = str(exc) or exc.__class__.__name__
        self.store.audit("service_call", ip, entity=entity_id, service=service, data=data, ok=error is None, error=error)
        if not ws.closed:
            await ws.send_json({"type": "result", "id": request_id, "success": error is None, "error": error})

    def _reject_reason(self, entity_id: str, service: str, data: Any) -> str | None:
        settings = self.store.settings
        if settings.data_source != "live":
            return "当前为演示数据，未连接 HA"
        if not settings.control_enabled:
            return "已关闭设备控制（只读模式）"
        if entity_id not in self.visible:
            return "该设备未在控制台显示（未发现或已被过滤）"
        allowed = ALLOWED_SERVICES.get(entity_id.split(".")[0], {}).get(service)
        if allowed is None:
            return f"不允许的服务：{service}"
        if not isinstance(data, dict) or any(key not in allowed or not allowed[key](value) for key, value in data.items()):
            return "服务参数不合法"
        if self.upstream.status.get("kind") != "connected":
            return "HA 未连接"
        return None

    # ---------- 管理接口 ----------

    def _require_admin(self, request: web.Request) -> None:
        if not self.sessions.touch(request.cookies.get(COOKIE)):
            raise web.HTTPUnauthorized(text=json.dumps({"error": "需要重新输入管理密码"}), content_type="application/json")

    async def login(self, request: web.Request) -> web.Response:
        ip = client_ip(request)
        retry_after = self.limiter.retry_after()
        if retry_after:
            return web.json_response({"error": "尝试次数过多", "retryAfter": retry_after}, status=429)
        body = await read_json(request)
        pin = body.get("pin")
        if not is_pin(pin) or not verify_pin(pin, self.store.settings.pin_hash):
            locked = self.limiter.record_failure()
            self.store.audit("login_failed", ip, locked_seconds=locked)
            if locked:
                return web.json_response({"error": "尝试次数过多", "retryAfter": locked}, status=429)
            return web.json_response({"error": "密码不正确", "remaining": self.limiter.remaining_attempts()}, status=401)
        self.limiter.record_success()
        self.store.audit("login", ip)
        response = web.json_response({"ok": True})
        response.set_cookie(COOKIE, self.sessions.create(), httponly=True, samesite="Strict", path="/api/admin", secure=request.secure)
        return response

    async def logout(self, request: web.Request) -> web.Response:
        self.sessions.revoke(request.cookies.get(COOKIE))
        response = web.json_response({"ok": True})
        response.del_cookie(COOKIE, path="/api/admin")
        return response

    def _settings_payload(self) -> dict[str, Any]:
        return {**self.store.settings.public(), "season": self.season.season(), "seasonSync": self.season.sync_status}

    async def get_settings(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        return web.json_response(self._settings_payload())

    async def put_settings(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        body = await read_json(request)
        settings = self.store.settings
        changed: list[str] = []
        reconnect = False

        if "haUrl" in body:
            url = normalize_ha_url(str(body["haUrl"]))
            if url is None:
                return web.json_response({"error": "地址需以 http:// 或 https:// 开头"}, status=400)
            if url != settings.ha_url:
                settings.ha_url, reconnect = url, True
                changed.append("haUrl")
        if body.get("clearToken"):
            self.store.set_token("")
            settings.data_source = "demo"
            reconnect = True
            changed += ["haToken(清除)", "dataSource"]
        elif isinstance(body.get("haToken"), str) and body["haToken"].strip():
            self.store.set_token(body["haToken"].strip())
            reconnect = True
            changed.append("haToken(更新)")
        if isinstance(body.get("controlEnabled"), bool) and body["controlEnabled"] != settings.control_enabled:
            settings.control_enabled = body["controlEnabled"]
            changed.append("controlEnabled")
        if body.get("dataSource") in ("demo", "live") and body["dataSource"] != settings.data_source:
            if body["dataSource"] == "live" and not (settings.ha_url and settings.token_encrypted):
                return web.json_response({"error": "请先保存 HA 地址和令牌"}, status=400)
            settings.data_source, reconnect = body["dataSource"], True
            changed.append("dataSource")

        if "theme" in body:
            if body["theme"] not in THEMES:
                return web.json_response({"error": "主题只能是浅色、深色或自动"}, status=400)
            if body["theme"] != settings.theme:
                settings.theme = body["theme"]
                changed.append("theme")
        if "accent" in body:
            if body["accent"] not in ACCENTS:
                return web.json_response({"error": "不支持的强调色"}, status=400)
            if body["accent"] != settings.accent:
                settings.accent = body["accent"]
                changed.append("accent")
        season_sync = False
        if "seasonRules" in body:
            if not isinstance(body["seasonRules"], bool):
                return web.json_response({"error": "参数错误"}, status=400)
            if body["seasonRules"] != settings.season_rules:
                settings.season_rules = body["seasonRules"]
                changed.append("seasonRules")
                season_sync = True
        if "season" in body:
            if body["season"] not in SEASONS:
                return web.json_response({"error": "季节只能是夏季或冬季"}, status=400)
            if not settings.season_rules:
                return web.json_response({"error": "请先启用季节规则"}, status=400)
            if body["season"] != self.season.season():
                try:
                    await self.season.set_season(body["season"])
                except Exception as exc:
                    return web.json_response({"error": f"切换季节失败：{exc}"}, status=409)
                changed.append("season")
        if "tileScale" in body:
            if not is_tile_scale(body["tileScale"]):
                return web.json_response({"error": f"格子大小需在 {TILE_SCALE_MIN}% 到 {TILE_SCALE_MAX}% 之间"}, status=400)
            if body["tileScale"] != settings.tile_scale:
                settings.tile_scale = body["tileScale"]
                changed.append("tileScale")
        if "homeTitle" in body:
            title = " ".join(str(body["homeTitle"]).split()) or DEFAULT_HOME_TITLE
            if len(title) > HOME_TITLE_MAX:
                return web.json_response({"error": f"标题最多 {HOME_TITLE_MAX} 个字"}, status=400)
            if title != settings.home_title:
                settings.home_title = title
                changed.append("homeTitle")
        if "homeSubtitle" in body:
            subtitle = " ".join(str(body["homeSubtitle"]).split())
            if len(subtitle) > HOME_SUBTITLE_MAX:
                return web.json_response({"error": f"副标题最多 {HOME_SUBTITLE_MAX} 个字"}, status=400)
            if subtitle != settings.home_subtitle:
                settings.home_subtitle = subtitle
                changed.append("homeSubtitle")
        weather_changed = False
        if body.get("clearWeatherKey"):
            self.store.set_weather_key("")
            weather_changed = True
            changed.append("weatherKey(清除)")
        elif isinstance(body.get("weatherKey"), str) and body["weatherKey"].strip():
            self.store.set_weather_key(body["weatherKey"].strip())
            weather_changed = True
            changed.append("weatherKey(更新)")
        for field_name, attribute in (("weatherHost", "weather_host"), ("weatherGeoHost", "weather_geo_host")):
            if field_name in body:
                host = normalize_host(str(body[field_name]))
                if host is None:
                    return web.json_response({"error": "和风天气 Host 格式错误，例如 abcd.re.qweatherapi.com"}, status=400)
                if host != getattr(settings, attribute):
                    setattr(settings, attribute, host)
                    weather_changed = True
                    changed.append(field_name)
        if weather_changed:
            self.weather.reset()

        if changed:
            self.store.save()
            self.store.audit("settings_changed", client_ip(request), fields=changed,
                             controlEnabled=settings.control_enabled, dataSource=settings.data_source, haUrl=settings.ha_url)
        if reconnect:
            await self.reconnect()
        if season_sync or reconnect:
            self.season.schedule()
        await self.broadcast(self.status_message())
        return web.json_response(self._settings_payload())

    def _entities_payload(self) -> dict[str, Any]:
        """设置页用：过滤设置，以及全部已发现的实体（含当前状态，便于辨认）。"""
        states = self.upstream.states
        return {
            "filter": self.store.settings.filter(),
            "rooms": self.discovered["rooms"],
            "entities": [{**entity, "state": (states.get(entity["id"]) or {}).get("state")} for entity in self.discovered["entities"]],
        }

    async def get_entities(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        return web.json_response(self._entities_payload())

    async def put_filter(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        body = await read_json(request)
        settings = self.store.settings
        if "mode" in body:
            if body["mode"] not in ("blacklist", "whitelist"):
                return web.json_response({"error": "过滤方式只能是黑名单或白名单"}, status=400)
            settings.filter_mode = body["mode"]
        for key in ("blacklist", "whitelist"):
            if key in body:
                ids = id_list(body[key])
                if ids is None:
                    return web.json_response({"error": "名单格式错误"}, status=400)
                setattr(settings, key, ids)
        self.store.save()
        self.store.audit("filter_changed", client_ip(request), mode=settings.filter_mode,
                         blacklist=len(settings.blacklist), whitelist=len(settings.whitelist))
        await self._apply_catalogue(self.discovered)
        return web.json_response(self._entities_payload())

    def _automations(self) -> tuple[str, list[dict[str, Any]]]:
        if self.store.settings.data_source != "live":
            return "demo", sorted(self.demo_automations.values(), key=lambda item: item["name"])
        registry = self.registries[2] if self.registries else []
        return "live", build_automations(self.upstream.states, registry)

    async def get_automations(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        source, items = self._automations()
        connected = source == "demo" or self.upstream.status.get("kind") == "connected"
        return web.json_response({"source": source, "connected": connected, "automations": items})

    async def put_automation(self, request: web.Request) -> web.Response:
        """开关一个自动化：只接受当前列表中的实体，只读模式下拒绝，结果写入操作记录。"""
        self._require_admin(request)
        if not self.store.settings.control_enabled:
            return web.json_response({"error": "已关闭设备控制（只读模式），不能切换自动化"}, status=403)
        body = await read_json(request)
        entity_id, enabled = body.get("id"), body.get("enabled")
        if not isinstance(entity_id, str) or not isinstance(enabled, bool):
            return web.json_response({"error": "参数错误"}, status=400)
        source, items = self._automations()
        if entity_id not in {item["id"] for item in items}:
            return web.json_response({"error": "找不到这个自动化"}, status=404)
        error: str | None = None
        if source == "demo":
            self.demo_automations[entity_id]["state"] = "on" if enabled else "off"
        else:
            try:
                await self.upstream.call_service(AUTOMATION_DOMAIN, "turn_on" if enabled else "turn_off", entity_id, {})
            except Exception as exc:  # HA 返回失败、超时或断线
                error = str(exc) or exc.__class__.__name__
        self.store.audit("automation_toggled", client_ip(request), entity=entity_id, enabled=enabled, ok=error is None, error=error)
        if error:
            return web.json_response({"error": f"切换失败：{error}"}, status=502)
        return web.json_response({"ok": True, "id": entity_id, "state": "on" if enabled else "off"})

    async def put_pin(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        body = await read_json(request)
        if not is_pin(body.get("pin")):
            return web.json_response({"error": "新密码需为 4 位数字"}, status=400)
        self.store.settings.pin_hash = hash_pin(body["pin"])
        self.store.save()
        self.store.audit("pin_changed", client_ip(request))
        return web.json_response({"ok": True})

    async def put_layout(self, request: web.Request) -> web.Response:
        """全家共用布局；只读模式下不允许修改。修改后推送给所有已打开的页面。"""
        if not self.store.settings.control_enabled:
            return web.json_response({"error": "已关闭设备控制（只读模式），不能修改布局"}, status=403)
        body = await read_json(request)
        self.store.save_layout(body)
        self.store.audit("layout_changed", client_ip(request), favorites=len(self.store.layout["favorites"] or []))
        await self.broadcast({"type": "layout", "layout": self.store.layout})
        return web.json_response(self.store.layout)

    async def test_weather(self, request: web.Request) -> web.Response:
        """用当前设置查询北京的实时天气，确认密钥与 Host 可用。"""
        self._require_admin(request)
        self.weather.reset()
        try:
            forecast = await self.weather.forecast("101010100")
        except WeatherError as error:
            return web.json_response({"ok": False, "error": str(error)})
        now = forecast["now"]
        return web.json_response({"ok": True, "summary": f"北京 {now.get('text')} {now.get('temp')}°"})

    async def get_audit(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        return web.json_response(self.store.recent_audit(int(request.query.get("limit", "50"))))


    # ---------- 天气（和风，只读，无需登录） ----------

    async def weather_search(self, request: web.Request) -> web.Response:
        query = request.query.get("q", "").strip()
        if not 0 < len(query) <= 40:
            return web.json_response({"error": "请输入 1–40 个字的地名"}, status=400)
        try:
            return web.json_response({"places": await self.weather.search(query)})
        except WeatherError as error:
            return web.json_response({"error": str(error)}, status=error.status)

    async def weather_place(self, request: web.Request) -> web.Response:
        """浏览器定位的坐标，或 HA 中“家”（zone.home）的坐标 → 和风位置。"""
        if request.query.get("home"):
            attributes = (self.upstream.states.get("zone.home") or {}).get("attributes") or {}
            lat, lon = attributes.get("latitude"), attributes.get("longitude")
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                return web.json_response({"error": "HA 未连接或未设置家的位置"}, status=404)
        else:
            try:
                lon, lat = float(request.query["lon"]), float(request.query["lat"])
            except (KeyError, ValueError):
                return web.json_response({"error": "坐标格式错误"}, status=400)
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                return web.json_response({"error": "坐标超出范围"}, status=400)
        try:
            return web.json_response({"place": await self.weather.place_at(lon, lat)})
        except WeatherError as error:
            return web.json_response({"error": str(error)}, status=error.status)

    async def weather_forecast(self, request: web.Request) -> web.Response:
        location = request.query.get("location", "").strip()
        if not valid_location(location):
            return web.json_response({"error": "位置格式错误"}, status=400)
        try:
            return web.json_response(await self.weather.forecast(location))
        except WeatherError as error:
            return web.json_response({"error": str(error)}, status=error.status)


def client_ip(request: web.Request) -> str:
    """只信任本机反向代理（如 Vite 开发代理）带来的 X-Forwarded-For。"""
    remote = request.remote or ""
    forwarded = request.headers.get("X-Forwarded-For")
    try:
        if forwarded and ipaddress.ip_address(remote).is_loopback:
            return forwarded.split(",")[0].strip()
    except ValueError:
        pass
    return remote


async def read_json(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text=json.dumps({"error": "请求格式错误"}), content_type="application/json")
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text=json.dumps({"error": "请求格式错误"}), content_type="application/json")
    return body


def create_app(data_dir: Path, static_dir: Path | None) -> web.Application:
    console = ConsoleServer(data_dir)
    app = web.Application()
    app["console"] = console
    app.add_routes([
        web.get("/api/health", lambda _request: web.json_response({"ok": True})),
        web.get("/api/ws", console.handle_ws),
        web.put("/api/layout", console.put_layout),
        web.post("/api/admin/login", console.login),
        web.post("/api/admin/logout", console.logout),
        web.get("/api/admin/settings", console.get_settings),
        web.put("/api/admin/settings", console.put_settings),
        web.get("/api/admin/entities", console.get_entities),
        web.put("/api/admin/filter", console.put_filter),
        web.get("/api/admin/automations", console.get_automations),
        web.put("/api/admin/automations", console.put_automation),
        web.put("/api/admin/pin", console.put_pin),
        web.get("/api/admin/audit", console.get_audit),
        web.post("/api/admin/weather/test", console.test_weather),
        web.get("/api/weather", console.weather_forecast),
        web.get("/api/weather/search", console.weather_search),
        web.get("/api/weather/place", console.weather_place),
    ])

    if static_dir and (static_dir / "index.html").exists():
        async def spa(request: web.Request) -> web.FileResponse:
            path = (static_dir / request.match_info["tail"]).resolve()
            if path.is_file() and static_dir.resolve() in path.parents:
                return web.FileResponse(path)
            return web.FileResponse(static_dir / "index.html")
        app.router.add_get("/{tail:(?!api/).*}", spa)

    async def on_startup(_app: web.Application) -> None:
        await console.reconnect()

    async def on_shutdown(_app: web.Application) -> None:
        # 先关闭页面的 WebSocket：否则 aiohttp 会等这些长连接自行结束（默认最长 60 秒），停止或重启服务时就会卡住。
        for client in list(console.clients):
            await client.close(code=1001, message=b"server shutdown")

    async def on_cleanup(_app: web.Application) -> None:
        await console.upstream.stop()
        await console.weather.close()

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="家庭控制台后端")
    parser.add_argument("--host", default=os.environ.get("HOME_CONSOLE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("HOME_CONSOLE_PORT", "8765")))
    parser.add_argument("--data", type=Path, default=Path(os.environ.get("HOME_CONSOLE_DATA", SERVER_DIR / "data")))
    parser.add_argument("--static", type=Path, default=Path(os.environ.get("HOME_CONSOLE_STATIC", SERVER_DIR.parent / "dist")),
                        help="构建后的前端目录；存在 index.html 时由本服务一并提供页面")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    web.run_app(create_app(args.data, args.static), host=args.host, port=args.port, access_log=None)
