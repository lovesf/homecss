import type { DeviceCommand } from './deviceCommands';
import type { Catalogue, CatalogueEntity, EntityState } from './consoleClient';
import type { BatteryReading, ClimateDevice, Device, HomeState, LightDevice, MediaDevice, Person, Room, SafetyDevice, SensorDevice } from './types';

type States = Map<string, EntityState>;

const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;

function usable(state: EntityState | undefined): state is EntityState {
  return Boolean(state && state.state !== 'unavailable' && state.state !== 'unknown');
}

const hex = (parts: number[]) => `#${parts.map((part) => Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, '0')).join('')}`;

function hsToHex(hue: number, saturation: number): string {
  const s = saturation / 100;
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    return 255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return hex([f(5), f(3), f(1)]);
}

function lightColor(attributes: Record<string, unknown>): string | undefined {
  const rgb = attributes.rgb_color;
  if (Array.isArray(rgb) && rgb.length === 3 && rgb.every((part) => typeof part === 'number')) return hex(rgb);
  const hs = attributes.hs_color;
  if (Array.isArray(hs) && hs.length === 2 && hs.every((part) => typeof part === 'number')) return hsToHex(hs[0], hs[1]);
  return undefined;
}

const colorModes = ['hs', 'rgb', 'xy', 'rgbw', 'rgbww'];

function toLight(base: LightDevice, previous: LightDevice | undefined, state: EntityState): LightDevice {
  const a = state.attributes;
  const brightness = num(a.brightness);
  const colorMode = str(a.color_mode);
  return {
    ...base,
    available: true,
    on: state.state === 'on',
    supportedColorModes: strings(a.supported_color_modes) ?? ['onoff'],
    brightness: brightness !== undefined ? Math.max(1, Math.round(brightness / 255 * 100)) : previous?.brightness,
    colorTemp: num(a.color_temp_kelvin) ?? previous?.colorTemp,
    minColorTempKelvin: num(a.min_color_temp_kelvin),
    maxColorTempKelvin: num(a.max_color_temp_kelvin),
    color: lightColor(a) ?? previous?.color,
    activeColorMode: colorMode === 'color_temp' ? 'color_temp' : colorMode && colorModes.includes(colorMode) ? 'color' : previous?.activeColorMode,
  };
}

function toClimate(base: ClimateDevice, previous: ClimateDevice | undefined, state: EntityState): ClimateDevice {
  const a = state.attributes;
  const on = state.state !== 'off';
  return {
    ...base,
    available: true,
    on,
    // 关闭时 HA 状态为 off，保留上次的运行模式用于显示“已关闭 · 制冷”和重新打开。
    mode: on ? state.state : previous?.mode ?? base.mode,
    target: num(a.temperature) ?? previous?.target ?? base.target,
    current: num(a.current_temperature),
    hvacModes: strings(a.hvac_modes) ?? base.hvacModes,
    fanMode: str(a.fan_mode),
    fanModes: strings(a.fan_modes),
    min: num(a.min_temp) ?? base.min,
    max: num(a.max_temp) ?? base.max,
    step: num(a.target_temp_step) ?? base.step,
  };
}

// media_player 的 supported_features 位
const feature = { pause: 1, volumeSet: 4, turnOn: 128, turnOff: 256, play: 16384 };
const mediaStatus: Record<string, MediaDevice['status']> = { off: 'off', standby: 'off', idle: 'idle', on: 'idle', playing: 'playing', paused: 'paused', buffering: 'playing' };

function toMedia(base: MediaDevice, previous: MediaDevice | undefined, state: EntityState): MediaDevice {
  const a = state.attributes;
  const features = num(a.supported_features) ?? 0;
  const volume = num(a.volume_level);
  return {
    ...base,
    available: true,
    status: mediaStatus[state.state] ?? 'unknown',
    detail: str(a.media_title) ?? str(a.app_name),
    canPower: Boolean(features & (feature.turnOn | feature.turnOff)),
    canPlayPause: Boolean(features & (feature.play | feature.pause)),
    volume: features & feature.volumeSet ? volume !== undefined ? Math.round(volume * 100) : previous?.volume : undefined,
  };
}

/** HA 没给显示精度时的兜底：温度最多 1 位小数，湿度取整。 */
const fallbackPrecision: Record<SensorDevice['metric'], number> = { temperature: 1, humidity: 0 };

/** 按 HA 显示精度格式化数值状态（27.700006 → 27.7）；没有精度时按兜底位数去掉浮点误差、不补零；非数值状态原样保留。 */
function formatSensorValue(raw: string, metric: SensorDevice['metric'], precision: number | undefined): string {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) return raw;
  return precision !== undefined ? value.toFixed(precision) : String(Number(value.toFixed(fallbackPrecision[metric])));
}

function toSensor(base: SensorDevice, state: EntityState): SensorDevice {
  return { ...base, available: true, value: formatSensorValue(state.state, base.metric, base.precision), unit: str(state.attributes.unit_of_measurement) ?? base.unit };
}

const safetyMessages: Record<SafetyDevice['sensorType'], [string, string]> = {
  door: ['已打开', '已关闭'],
  motion: ['检测到移动', '未检测到移动'],
  leak: ['检测到水浸', '未检测到水浸'],
  smoke: ['检测到烟雾', '未检测到烟雾'],
};

function toSafety(base: SafetyDevice, state: EntityState): SafetyDevice {
  const status = state.state === 'on' ? 'alert' : state.state === 'off' ? 'normal' : 'unknown';
  const [alertText, normalText] = safetyMessages[base.sensorType];
  return { ...base, available: true, status, message: status === 'alert' ? alertText : status === 'normal' ? normalText : '状态未知' };
}

function toDevice(base: Device, previous: Device | undefined, state: EntityState): Device {
  switch (base.kind) {
    case 'light': return toLight(base, previous?.kind === 'light' ? previous : undefined, state);
    case 'climate':
    case 'heating': return toClimate(base, previous && (previous.kind === 'climate' || previous.kind === 'heating') ? previous : undefined, state);
    case 'media': return toMedia(base, previous?.kind === 'media' ? previous : undefined, state);
    case 'sensor': return toSensor(base, state);
    case 'safety': return toSafety(base, state);
  }
}

/** 未分配区域的实体放进这个房间，排在最后。 */
export const unassignedRoomId = '_unassigned';

const safetyTypes: Record<string, SafetyDevice['sensorType']> = {
  door: 'door', window: 'door', opening: 'door', garage_door: 'door',
  motion: 'motion', occupancy: 'motion', presence: 'motion',
  moisture: 'leak',
  smoke: 'smoke', gas: 'smoke', carbon_monoxide: 'smoke',
};

/** 只能制热（或只有制热和关闭）的温控按地暖显示。 */
function isHeatingOnly(state: EntityState | undefined): boolean {
  const modes = strings(state?.attributes.hvac_modes);
  return Boolean(modes && modes.length > 0 && modes.every((mode) => mode === 'heat' || mode === 'off'));
}

/** 由目录条目生成设备骨架（尚无状态时的默认值）；非设备卡类实体返回 null。 */
function baseDevice(entity: CatalogueEntity, roomId: string, state: EntityState | undefined): Device | null {
  const common = { id: entity.id, roomId, name: entity.name, available: false };
  switch (entity.domain) {
    case 'light':
      return { ...common, kind: 'light', on: false, supportedColorModes: ['onoff'] };
    case 'climate': {
      const heating = isHeatingOnly(state);
      return { ...common, kind: heating ? 'heating' : 'climate', on: false, target: 0, mode: heating ? 'heat' : 'cool', hvacModes: [], min: 5, max: 35, step: heating ? 0.5 : 1 };
    }
    case 'media_player':
      return { ...common, kind: 'media', mediaType: entity.deviceClass === 'speaker' ? 'speaker' : 'tv', status: 'unknown' };
    case 'sensor':
      if (entity.deviceClass !== 'temperature' && entity.deviceClass !== 'humidity') return null;
      return { ...common, kind: 'sensor', metric: entity.deviceClass, value: '', unit: entity.deviceClass === 'temperature' ? '°C' : '%', precision: entity.precision };
    case 'binary_sensor': {
      const sensorType = entity.deviceClass ? safetyTypes[entity.deviceClass] : undefined;
      return sensorType ? { ...common, kind: 'safety', sensorType, status: 'unknown', message: '状态未知' } : null;
    }
    default:
      return null;
  }
}

/** 设置页显示用的实体类型名称。 */
export function entityKindLabel(entity: Pick<CatalogueEntity, 'domain' | 'deviceClass'>): string {
  switch (entity.domain) {
    case 'light': return '灯';
    case 'climate': return '温控';
    case 'media_player': return '播放器';
    case 'person': return '人员';
    case 'sensor': return entity.deviceClass === 'temperature' ? '温度' : entity.deviceClass === 'humidity' ? '湿度' : '电量';
    case 'binary_sensor': {
      const type = entity.deviceClass ? safetyTypes[entity.deviceClass] : undefined;
      return type === 'door' ? '门窗' : type === 'motion' ? '人体' : type === 'leak' ? '水浸' : '烟雾';
    }
    default: return entity.domain;
  }
}

/**
 * 以后端发现并过滤后的目录为骨架，用 HA 实时状态生成页面数据：区域即房间，灯 / 温控 / 播放器为设备卡，
 * 温湿度与门窗、人体、水浸、烟雾进顶部摘要，电量传感器进电池提醒，人员进在家状态。
 * 不可用的设备一律显示为不可用，不会显示成“关”；previous 用来保留 HA 暂未上报的属性（例如关灯后的亮度）。
 */
export function liveHome(catalogue: Catalogue | null, states: States, previous: HomeState | null): HomeState {
  const entities = catalogue?.entities ?? [];
  const rooms: Room[] = (catalogue?.rooms ?? []).map((room) => ({ id: room.id, name: room.name, category: 'main' }));
  if (entities.some((entity) => entity.areaId === null)) rooms.push({ id: unassignedRoomId, name: '未分配区域', category: 'other' });
  const previousDevices = new Map(previous?.devices.map((device) => [device.id, device]));
  const devices: Device[] = [];
  const batteries: BatteryReading[] = [];
  const people: Person[] = [];

  for (const entity of entities) {
    const roomId = entity.areaId ?? unassignedRoomId;
    const state = states.get(entity.id);
    if (entity.domain === 'person') {
      people.push({ id: entity.id, name: entity.name, source: 'HA', status: !usable(state) ? 'unknown' : state.state === 'home' ? 'home' : 'away' });
      continue;
    }
    if (entity.domain === 'sensor' && entity.deviceClass === 'battery') {
      const level = usable(state) ? Number(state.state) : NaN;
      batteries.push({ id: entity.id, roomId, name: entity.name, available: usable(state), level: Number.isFinite(level) ? Math.round(level) : null });
      continue;
    }
    const base = baseDevice(entity, roomId, state);
    if (!base) continue;
    const prior = previousDevices.get(entity.id);
    if (!usable(state)) devices.push(prior && prior.kind === base.kind ? { ...prior, roomId, name: base.name, available: false } : base);
    else devices.push(toDevice(base, prior && prior.kind === base.kind ? prior : undefined, state));
  }
  return { rooms, devices, batteries, people };
}

export interface ServiceCall {
  /** 仅用于说明；后端按设备映射的实体自行确定 domain。 */
  domain: string;
  service: string;
  data: Record<string, unknown>;
}

function rgbFromHex(color: string): number[] {
  const value = color.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}

/** 把已通过能力校验的操作翻译成 HA 服务调用；后端还会按白名单再次校验服务与参数。 */
export function serviceCall(after: Device, command: DeviceCommand): ServiceCall | null {
  switch (command.type) {
    case 'toggle':
      if (after.kind === 'light') return { domain: 'light', service: after.on ? 'turn_on' : 'turn_off', data: {} };
      if (after.kind === 'climate' || after.kind === 'heating') {
        const mode = after.mode !== 'off' ? after.mode : after.hvacModes.find((option) => option !== 'off');
        return mode ? { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: after.on ? mode : 'off' } } : null;
      }
      return null;
    case 'turnOff':
      if (after.kind === 'light') return { domain: 'light', service: 'turn_off', data: {} };
      if (after.kind === 'climate' || after.kind === 'heating') return { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: 'off' } };
      return null;
    case 'adjust':
      return after.kind === 'climate' || after.kind === 'heating' ? { domain: 'climate', service: 'set_temperature', data: { temperature: after.target } } : null;
    case 'light': {
      const data: Record<string, unknown> = {};
      if (command.patch.brightness !== undefined) data.brightness_pct = command.patch.brightness;
      if (command.patch.colorTemp !== undefined) data.color_temp_kelvin = command.patch.colorTemp;
      if (command.patch.color !== undefined) data.rgb_color = rgbFromHex(command.patch.color);
      return { domain: 'light', service: 'turn_on', data };
    }
    case 'hvacMode':
      return { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: command.mode } };
    case 'fanMode':
      return { domain: 'climate', service: 'set_fan_mode', data: { fan_mode: command.fanMode } };
    case 'mediaPower':
      return after.kind === 'media' ? { domain: 'media_player', service: after.status === 'off' ? 'turn_off' : 'turn_on', data: {} } : null;
    case 'mediaPlayPause':
      return { domain: 'media_player', service: 'media_play_pause', data: {} };
    case 'mediaVolume':
      return { domain: 'media_player', service: 'volume_set', data: { volume_level: command.volume / 100 } };
  }
}
