export type TileSize = '1x1' | '2x1';

export interface Room {
  id: string;
  name: string;
  category: 'main' | 'other';
}

interface BaseDevice {
  id: string;
  roomId: string;
  name: string;
  available: boolean;
}

export interface LightDevice extends BaseDevice {
  kind: 'light';
  on: boolean;
  supportedColorModes: string[];
  brightness?: number;
  colorTemp?: number;
  minColorTempKelvin?: number;
  maxColorTempKelvin?: number;
  color?: string;
  activeColorMode?: 'color' | 'color_temp';
}

export interface ClimateDevice extends BaseDevice {
  kind: 'climate' | 'heating';
  on: boolean;
  target: number;
  current?: number;
  mode: string;
  hvacModes: string[];
  fanMode?: string;
  fanModes?: string[];
  min: number;
  max: number;
  step: number;
}

export interface SensorDevice extends BaseDevice {
  kind: 'sensor';
  value: string;
  unit: string;
  metric: 'temperature' | 'humidity';
  /** HA 的显示小数位；用于把 27.700006 这类原始状态格式化为 27.7。 */
  precision?: number;
}

export interface SafetyDevice extends BaseDevice {
  kind: 'safety';
  sensorType: 'door' | 'motion' | 'leak' | 'smoke';
  status: 'normal' | 'alert' | 'unknown';
  message: string;
}

export interface BatteryReading {
  id: string;
  roomId: string;
  name: string;
  level: number | null;
  available: boolean;
}

export interface MediaDevice extends BaseDevice {
  kind: 'media';
  mediaType: 'tv' | 'speaker';
  status: 'off' | 'idle' | 'playing' | 'paused' | 'unknown';
  detail?: string;
  canPower?: boolean;
  canPlayPause?: boolean;
  volume?: number;
}

export type Device = LightDevice | ClimateDevice | SensorDevice | SafetyDevice | MediaDevice;

export interface Person {
  id: string;
  name: string;
  status: 'home' | 'away' | 'unknown';
  source: string;
}

export interface HomeState {
  rooms: Room[];
  devices: Device[];
  batteries: BatteryReading[];
  people: Person[];
}

export type LightPatch = Partial<Pick<LightDevice, 'brightness' | 'colorTemp' | 'color'>>;

/** 设备卡可触发的操作；目前只改内存中的模拟状态，接入 HA 时在这一层换成服务调用。 */
export interface DeviceActions {
  toggle: (id: string) => void;
  /** 明确关闭（灯、空调、地暖）；已关闭的不发送请求。 */
  turnOff: (id: string) => void;
  adjust: (id: string, delta: number) => void;
  changeLight: (id: string, patch: LightPatch) => void;
  changeClimateMode: (id: string, mode: string) => void;
  changeFanMode: (id: string, fanMode: string) => void;
  mediaPower: (id: string) => void;
  mediaPlayPause: (id: string) => void;
  mediaVolume: (id: string, volume: number) => void;
}

export interface LayoutState {
  sizes: Record<string, TileSize>;
  order: Record<string, string[]>;
  /** 全屋“常用设备”的设备 id 与顺序；未设置过时使用默认清单。 */
  favorites?: string[];
  /** 导航中的房间顺序（房间 id）；未列出的房间按自动发现 / 演示数据的原顺序排在后面。 */
  rooms?: string[];
}
