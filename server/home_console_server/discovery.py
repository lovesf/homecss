"""从 HA 自动发现控制台要显示的实体，并按设置中的黑名单 / 白名单过滤。

- 房间取自 HA 区域：优先实体自身的区域，其次所属设备的区域；都没有时，名称以某个区域名开头（命名规范“区域-设备”）
  则归入该区域，否则为未分配（areaId 为 None）。在 HA 中补上区域后以 HA 为准。
- 只收录灯、温控、播放器、人员，以及温度 / 湿度 / 电池传感器和门窗 / 人体 / 水浸 / 烟雾类二元传感器。
- 在 HA 中被禁用、隐藏或属于配置 / 诊断类别的实体不参与发现；需要隐藏某个设备时也可以直接在 HA 里隐藏。
"""

from __future__ import annotations

from typing import Any

SENSOR_CLASSES = {"temperature", "humidity", "battery"}
BINARY_CLASSES = {
    "door", "window", "opening", "garage_door",
    "motion", "occupancy", "presence",
    "moisture",
    "smoke", "gas", "carbon_monoxide",
}
CONTROL_DOMAINS = {"light", "climate", "media_player"}
NAME_SEPARATORS = " -－—_·:："


def relevant(domain: str, device_class: str | None) -> bool:
    if domain in CONTROL_DOMAINS or domain == "person":
        return True
    if domain == "sensor":
        return device_class in SENSOR_CLASSES
    if domain == "binary_sensor":
        return device_class in BINARY_CLASSES
    return False


def display_name(friendly_name: str, area_name: str | None) -> str:
    """去掉名称开头重复的区域名，例如“客厅-背景灯”在客厅中显示为“背景灯”。"""
    if area_name and friendly_name.startswith(area_name):
        rest = friendly_name[len(area_name):].lstrip(NAME_SEPARATORS)
        if rest:
            return rest
    return friendly_name


def area_from_name(friendly_name: str, areas: list[dict[str, Any]]) -> str | None:
    """按“区域-设备”命名取最长匹配的区域名。"""
    matches = [area for area in areas if area["name"] and friendly_name.startswith(area["name"])]
    return max(matches, key=lambda area: len(area["name"]))["area_id"] if matches else None


def display_precision(entry: dict[str, Any]) -> int | None:
    """HA 中传感器的显示小数位：用户在 HA 设置的优先，其次集成建议的；原始状态可能带浮点误差（如 27.700006）。"""
    options = (entry.get("options") or {}).get("sensor") or {}
    for key in ("display_precision", "suggested_display_precision"):
        value = options.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 6:
            return value
    return None


def build_catalogue(areas: list[dict[str, Any]], devices: list[dict[str, Any]], registry: list[dict[str, Any]],
                    states: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """返回全部发现结果：rooms 为按 HA 顺序排列的区域，entities 为可显示的实体（不含过滤）。"""
    entries = {entry["entity_id"]: entry for entry in registry}
    device_area = {device["id"]: device.get("area_id") for device in devices}
    area_names = {area["area_id"]: area["name"] for area in areas}
    entities: list[dict[str, Any]] = []
    for entity_id, state in states.items():
        domain = entity_id.split(".")[0]
        attributes = state.get("attributes") or {}
        entry = entries.get(entity_id) or {}
        if entry.get("disabled_by") or entry.get("hidden_by") or entry.get("entity_category"):
            continue
        device_class = attributes.get("device_class") or entry.get("device_class") or entry.get("original_device_class")
        if not relevant(domain, device_class):
            continue
        friendly = str(attributes.get("friendly_name") or entry.get("name") or entry.get("original_name") or entity_id)
        area_id = entry.get("area_id") or device_area.get(entry.get("device_id"))
        if area_id not in area_names:
            area_id = area_from_name(friendly, areas)
        entity = {
            "id": entity_id,
            "domain": domain,
            "deviceClass": device_class,
            "areaId": area_id,
            "name": display_name(friendly, area_names.get(area_id)),
        }
        if domain == "sensor" and (precision := display_precision(entry)) is not None:
            entity["precision"] = precision
        entities.append(entity)
    used = {entity["areaId"] for entity in entities}
    rooms = [{"id": area["area_id"], "name": area["name"]} for area in areas if area["area_id"] in used]
    return {"rooms": rooms, "entities": entities}


def visible_ids(catalogue: dict[str, Any], mode: str, blacklist: list[str], whitelist: list[str]) -> set[str]:
    ids = {entity["id"] for entity in catalogue["entities"]}
    if mode == "whitelist":
        return ids & set(whitelist)
    return ids - set(blacklist)


def filtered(catalogue: dict[str, Any], ids: set[str]) -> dict[str, Any]:
    """页面用的目录：只含可见实体，以及有可见实体的房间。"""
    entities = [entity for entity in catalogue["entities"] if entity["id"] in ids]
    used = {entity["areaId"] for entity in entities}
    return {"rooms": [room for room in catalogue["rooms"] if room["id"] in used], "entities": entities}
