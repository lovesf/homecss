"""设置与审计记录的持久化。

- settings.json：HA 地址、控制开关、数据来源、设备过滤（黑名单 / 白名单）、管理密码的 scrypt 哈希、加密后的 HA 令牌，
  以及和风天气的 API Host 与加密后的密钥。文件权限 0600。
- 令牌与和风天气密钥用 Fernet（AES-128-CBC + HMAC）加密。密钥优先取环境变量 HOME_CONSOLE_SECRET；
  未设置时在数据目录生成 secret.key（与 Node-RED 的 _credentialSecret 同理：能读到整个数据目录的人仍可解密）。
- layout.json：全家共用的布局（卡片尺寸、房间内顺序、常用设备、房间顺序），所有屏幕看到同一份。
- audit.log：每行一条 JSON，记录登录、设置变更与设备控制；从不写入令牌或密码。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

DEFAULT_PIN = "1234"
THEMES = ("dark", "light", "auto")
ACCENTS = ("amber", "coral", "rose", "violet", "sky", "teal", "green")  # 强调色，第一个为默认
DEFAULT_HOME_TITLE = "我的家庭"
HOME_TITLE_MAX = 12
DEFAULT_HOME_SUBTITLE = "常用设备与正在运行的设备，一眼看清"
HOME_SUBTITLE_MAX = 60
TILE_SCALE_MIN, TILE_SCALE_MAX, TILE_SCALE_DEFAULT = 80, 120, 100  # 设备格子缩放百分比
AUDIT_MAX_BYTES = 1_000_000


def _write_private(path: Path, text: str) -> None:
    """原子写入并限制为仅属主可读写。"""
    temp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(temp, path)


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(pin.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    return hmac.compare_digest(hash_pin(pin, bytes.fromhex(salt_hex)).split("$")[2], digest_hex)


TILE_SIZES = ("1x1", "2x1")
MAX_ID_LENGTH = 255


def id_list(value: Any) -> list[str] | None:
    if not isinstance(value, list) or len(value) > 2000:
        return None
    if not all(isinstance(item, str) and 0 < len(item) <= MAX_ID_LENGTH for item in value):
        return None
    return list(dict.fromkeys(value))


def clean_layout(raw: Any) -> dict[str, Any]:
    """只保留合法字段：sizes 设备 → 1x1/2x1，order 房间 → 设备顺序，favorites 常用设备（null 表示用默认清单），rooms 导航房间顺序（空表示默认顺序）。"""
    raw = raw if isinstance(raw, dict) else {}
    sizes = raw.get("sizes") if isinstance(raw.get("sizes"), dict) else {}
    order = raw.get("order") if isinstance(raw.get("order"), dict) else {}
    layout: dict[str, Any] = {
        "sizes": {key: value for key, value in sizes.items() if isinstance(key, str) and len(key) <= MAX_ID_LENGTH and value in TILE_SIZES},
        "order": {key: ids for key, value in order.items() if isinstance(key, str) and len(key) <= MAX_ID_LENGTH and (ids := id_list(value)) is not None},
        "favorites": id_list(raw.get("favorites")),
        "rooms": id_list(raw.get("rooms")) or [],
    }
    return layout


def is_pin(value: object) -> bool:
    return isinstance(value, str) and len(value) == 4 and value.isdigit()


@dataclass
class Settings:
    ha_url: str = ""
    control_enabled: bool = True
    data_source: str = "demo"  # demo | live
    pin_hash: str = ""
    token_encrypted: str = ""
    filter_mode: str = "blacklist"  # blacklist：显示全部发现的实体，名单内的隐藏；whitelist：只显示名单内的
    blacklist: list[str] = field(default_factory=list)
    whitelist: list[str] = field(default_factory=list)
    weather_key_encrypted: str = ""
    weather_host: str = ""  # 空表示默认 api.qweather.com
    weather_geo_host: str = ""  # 空表示默认 geoapi.qweather.com
    theme: str = "dark"  # dark | light | auto（日出到日落浅色，其余深色）
    home_title: str = DEFAULT_HOME_TITLE  # 首页标题，同时用作导航入口名称；不能为空
    home_subtitle: str = DEFAULT_HOME_SUBTITLE  # “我的家庭”标题下的一句话，空字符串表示不显示
    accent: str = ACCENTS[0]  # 强调色（设置 → 显示），所有屏幕共用
    season_rules: bool = False  # 季节规则（设置 → 自动化）：启用后由控制台在 HA 中维护季节辅助元素和自动化
    season_demo: str = "summer"  # 演示模式下的季节；HA 模式的季节保存在 HA 的季节辅助元素中
    tile_scale: int = TILE_SCALE_DEFAULT  # 设备格子缩放百分比（80–120），所有屏幕共用

    def filter(self) -> dict[str, Any]:
        return {"mode": self.filter_mode, "blacklist": self.blacklist, "whitelist": self.whitelist}

    def public(self) -> dict[str, Any]:
        """给已登录管理员看的设置；令牌只返回是否已保存。"""
        return {
            "haUrl": self.ha_url,
            "hasToken": bool(self.token_encrypted),
            "controlEnabled": self.control_enabled,
            "dataSource": self.data_source,
            "hasWeatherKey": bool(self.weather_key_encrypted),
            "weatherHost": self.weather_host,
            "weatherGeoHost": self.weather_geo_host,
            "homeTitle": self.home_title,
            "homeSubtitle": self.home_subtitle,
            "theme": self.theme,
            "tileScale": self.tile_scale,
            "accent": self.accent,
            "seasonRules": self.season_rules,
        }


def is_tile_scale(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and TILE_SCALE_MIN <= value <= TILE_SCALE_MAX


class Store:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(data_dir, 0o700)
        self.settings_path = data_dir / "settings.json"
        self.audit_path = data_dir / "audit.log"
        self.fernet = Fernet(self._load_key())
        self.settings = self._load_settings()
        self.layout_path = data_dir / "layout.json"
        self.layout = self._load_layout()

    def _load_key(self) -> bytes:
        secret = os.environ.get("HOME_CONSOLE_SECRET")
        if secret:
            return secret.encode()
        key_path = self.data_dir / "secret.key"
        if not key_path.exists():
            _write_private(key_path, Fernet.generate_key().decode())
        return key_path.read_text().strip().encode()

    def _load_settings(self) -> Settings:
        if not self.settings_path.exists():
            settings = Settings(pin_hash=hash_pin(DEFAULT_PIN))
            self._save(settings)
            return settings
        raw = json.loads(self.settings_path.read_text(encoding="utf-8"))
        return Settings(
            ha_url=str(raw.get("haUrl", "")),
            control_enabled=bool(raw.get("controlEnabled", True)),
            data_source="live" if raw.get("dataSource") == "live" else "demo",
            pin_hash=str(raw.get("pinHash") or hash_pin(DEFAULT_PIN)),
            token_encrypted=str(raw.get("tokenEncrypted", "")),
            filter_mode="whitelist" if raw.get("filterMode") == "whitelist" else "blacklist",
            blacklist=id_list(raw.get("blacklist")) or [],
            whitelist=id_list(raw.get("whitelist")) or [],
            weather_key_encrypted=str(raw.get("weatherKeyEncrypted", "")),
            weather_host=str(raw.get("weatherHost", "")),
            weather_geo_host=str(raw.get("weatherGeoHost", "")),
            theme=raw.get("theme") if raw.get("theme") in THEMES else "dark",
            home_title=str(raw.get("homeTitle") or DEFAULT_HOME_TITLE)[:HOME_TITLE_MAX],
            home_subtitle=str(raw.get("homeSubtitle", DEFAULT_HOME_SUBTITLE))[:HOME_SUBTITLE_MAX],
            tile_scale=raw["tileScale"] if is_tile_scale(raw.get("tileScale")) else TILE_SCALE_DEFAULT,
            accent=raw.get("accent") if raw.get("accent") in ACCENTS else ACCENTS[0],
            season_rules=raw.get("seasonRules") is True,
            season_demo=raw.get("seasonDemo") if raw.get("seasonDemo") in ("summer", "winter") else "summer",
        )

    def _save(self, settings: Settings) -> None:
        payload = {
            "haUrl": settings.ha_url,
            "controlEnabled": settings.control_enabled,
            "dataSource": settings.data_source,
            "pinHash": settings.pin_hash,
            "tokenEncrypted": settings.token_encrypted,
            "filterMode": settings.filter_mode,
            "blacklist": settings.blacklist,
            "whitelist": settings.whitelist,
            "weatherKeyEncrypted": settings.weather_key_encrypted,
            "weatherHost": settings.weather_host,
            "weatherGeoHost": settings.weather_geo_host,
            "homeTitle": settings.home_title,
            "homeSubtitle": settings.home_subtitle,
            "theme": settings.theme,
            "tileScale": settings.tile_scale,
            "accent": settings.accent,
            "seasonRules": settings.season_rules,
            "seasonDemo": settings.season_demo,
        }
        _write_private(self.settings_path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    def save(self) -> None:
        self._save(self.settings)

    def _load_layout(self) -> dict[str, Any]:
        if not self.layout_path.exists():
            return clean_layout({})
        try:
            return clean_layout(json.loads(self.layout_path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            return clean_layout({})

    def save_layout(self, layout: dict[str, Any]) -> None:
        self.layout = clean_layout(layout)
        _write_private(self.layout_path, json.dumps(self.layout, ensure_ascii=False, indent=2) + "\n")

    def _decrypt(self, value: str) -> str:
        if not value:
            return ""
        try:
            return self.fernet.decrypt(value.encode()).decode()
        except InvalidToken:
            # 加密密钥更换后旧值无法解密，按未设置处理，需重新填写。
            return ""

    def _encrypt(self, value: str) -> str:
        return self.fernet.encrypt(value.encode()).decode() if value else ""

    def token(self) -> str:
        return self._decrypt(self.settings.token_encrypted)

    def set_token(self, token: str) -> None:
        self.settings.token_encrypted = self._encrypt(token)

    def weather_key(self) -> str:
        return self._decrypt(self.settings.weather_key_encrypted)

    def set_weather_key(self, key: str) -> None:
        self.settings.weather_key_encrypted = self._encrypt(key)

    def audit(self, event: str, ip: str, **detail: Any) -> None:
        entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event, "ip": ip, **detail}
        if self.audit_path.exists() and self.audit_path.stat().st_size > AUDIT_MAX_BYTES:
            os.replace(self.audit_path, self.audit_path.with_suffix(".log.1"))
        fd = os.open(self.audit_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def recent_audit(self, limit: int = 50) -> list[dict[str, Any]]:
        if not self.audit_path.exists():
            return []
        lines = self.audit_path.read_text(encoding="utf-8").splitlines()[-limit:]
        entries = []
        for line in reversed(lines):
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries
