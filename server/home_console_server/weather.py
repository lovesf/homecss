"""和风天气（QWeather）代理：密钥只保存在服务端，页面经 /api/weather/* 获取城市搜索、实时天气和未来 7 天预报。

- 密钥与主机：在设置页“连接”中填写，由服务加密保存（见 store.py），每次请求时读取，修改后立即生效。
  设置为空时依次使用环境变量 QWEATHER_API_KEY / QWEATHER_API_HOST / QWEATHER_GEO_HOST（仅供开发测试）；
  主机默认 api.qweather.com 与 geoapi.qweather.com，使用和风控制台分配的专属 API Host 时填写。
- 缓存：天气 10 分钟、城市搜索 1 天，按请求参数缓存在内存中，多块屏幕同时打开也不会重复请求；修改设置时清空。
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any, Callable

import aiohttp

DEFAULT_HOST = "api.qweather.com"
DEFAULT_GEO_HOST = "geoapi.qweather.com"
WEATHER_TTL = 600
GEO_TTL = 86_400
CACHE_LIMIT = 500

ERRORS = {
    "204": "该地区暂无天气数据",
    "400": "请求参数错误",
    "401": "和风天气密钥无效",
    "402": "和风天气额度已用完",
    "403": "和风天气密钥无权访问该数据",
    "404": "未找到该位置",
    "429": "请求过于频繁，请稍后再试",
    "500": "和风天气服务异常，请稍后再试",
}

LOCATION_ID = re.compile(r"^[A-Za-z0-9]{3,16}$")  # 和风位置 ID，城市多为数字，乡镇等可含字母
HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$")
COORDINATES = re.compile(r"^-?\d{1,3}(\.\d{1,6})?,-?\d{1,2}(\.\d{1,6})?$")

NOW_FIELDS = ("obsTime", "temp", "feelsLike", "icon", "text", "windDir", "windScale", "windSpeed", "humidity", "precip", "pressure", "vis")
DAILY_FIELDS = ("fxDate", "tempMax", "tempMin", "iconDay", "textDay", "iconNight", "textNight", "windDirDay", "windScaleDay",
                "precip", "humidity", "uvIndex", "sunrise", "sunset")


class WeatherError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def normalize_host(value: str) -> str | None:
    """接受带或不带 https:// 和路径的写法，只保留主机（及端口）；空字符串表示使用默认主机；非法返回 None。"""
    host = re.sub(r"^https?://", "", value.strip(), flags=re.IGNORECASE).split("/")[0]
    if not host:
        return ""
    return host if HOST.match(host) else None


def valid_location(value: str) -> bool:
    return bool(LOCATION_ID.match(value) or COORDINATES.match(value))


def coordinates(lon: float, lat: float) -> str:
    """和风的坐标格式：经度在前，最多两位小数。"""
    return f"{lon:.2f},{lat:.2f}"


def _place(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(raw.get("id", "")),
        "name": str(raw.get("name", "")),
        "adm2": str(raw.get("adm2", "")),
        "adm1": str(raw.get("adm1", "")),
        "country": str(raw.get("country", "")),
        "lat": float(raw.get("lat") or 0),
        "lon": float(raw.get("lon") or 0),
    }


class Weather:
    def __init__(self, config: Callable[[], tuple[str, str, str]]) -> None:
        """config 返回当前设置中的 (密钥, 天气主机, 城市搜索主机)，空值使用环境变量或默认值。"""
        self._config = config
        self._cache: dict[tuple[str, str, tuple[tuple[str, str], ...]], tuple[float, dict[str, Any]]] = {}
        self._session: aiohttp.ClientSession | None = None

    def settings(self) -> tuple[str, str, str]:
        key, host, geo_host = self._config()
        return (
            key or os.environ.get("QWEATHER_API_KEY", "").strip(),
            host or os.environ.get("QWEATHER_API_HOST", "").strip() or DEFAULT_HOST,
            geo_host or os.environ.get("QWEATHER_GEO_HOST", "").strip() or DEFAULT_GEO_HOST,
        )

    def reset(self) -> None:
        self._cache.clear()

    async def close(self) -> None:
        if self._session:
            await self._session.close()

    async def _get(self, geo: bool, path: str, params: dict[str, str], ttl: int) -> dict[str, Any]:
        key, weather_host, geo_host = self.settings()
        if not key:
            raise WeatherError("未配置和风天气密钥，请在设置 → 连接中填写", 503)
        host = geo_host if geo else weather_host
        cache_key = (host, path, tuple(sorted(params.items())))
        cached = self._cache.get(cache_key)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        if self._session is None or self._session.closed:
            # trust_env：服务所在机器若需代理访问外网，沿用 HTTPS_PROXY 等环境变量。
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10), trust_env=True)
        try:
            async with self._session.get(f"https://{host}{path}", params=params, headers={"X-QW-Api-Key": key}) as response:
                data = await response.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as error:
            raise WeatherError(f"无法连接和风天气：{error.__class__.__name__}") from error
        code = str(data.get("code", response.status))
        if code != "200":
            raise WeatherError(ERRORS.get(code, f"和风天气返回错误（{code}）"), 404 if code in ("204", "404") else 502)
        if len(self._cache) >= CACHE_LIMIT:
            now = time.monotonic()
            self._cache = {key: value for key, value in self._cache.items() if value[0] > now}
        self._cache[cache_key] = (time.monotonic() + ttl, data)
        return data

    async def search(self, query: str) -> list[dict[str, Any]]:
        data = await self._get(True, "/v2/city/lookup", {"location": query, "number": "10", "lang": "zh"}, GEO_TTL)
        return [_place(item) for item in data.get("location") or []]

    async def place_at(self, lon: float, lat: float) -> dict[str, Any]:
        places = await self._get(True, "/v2/city/lookup", {"location": coordinates(lon, lat), "number": "1", "lang": "zh"}, GEO_TTL)
        items = places.get("location") or []
        if not items:
            raise WeatherError("未找到该位置", 404)
        return _place(items[0])

    async def forecast(self, location: str) -> dict[str, Any]:
        params = {"location": location, "lang": "zh", "unit": "m"}
        now, week = await asyncio.gather(
            self._get(False, "/v7/weather/now", params, WEATHER_TTL),
            self._get(False, "/v7/weather/7d", params, WEATHER_TTL),
        )
        return {
            "updateTime": now.get("updateTime"),
            "fxLink": now.get("fxLink"),
            "now": {key: (now.get("now") or {}).get(key) for key in NOW_FIELDS},
            "daily": [{key: day.get(key) for key in DAILY_FIELDS} for day in (week.get("daily") or [])[:7]],
        }
