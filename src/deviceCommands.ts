import { getLightVariant, supportsColor, supportsColorTemperature } from './light';
import { isClimate } from './selectors';
import type { Device, LightPatch } from './types';

export type DeviceCommand =
  | { type: 'toggle' }
  | { type: 'turnOff' }
  | { type: 'adjust'; delta: number }
  | { type: 'light'; patch: LightPatch }
  | { type: 'hvacMode'; mode: string }
  | { type: 'fanMode'; fanMode: string }
  | { type: 'mediaPower' }
  | { type: 'mediaPlayPause' }
  | { type: 'mediaVolume'; volume: number };

/**
 * 按设备能力把操作应用到设备状态；不支持或不可用时原样返回同一个对象。
 * 演示模式直接用它改内存，HA 模式用它做乐观更新并判断是否需要调用服务。
 */
export function applyCommand(device: Device, command: DeviceCommand): Device {
  if (!device.available) return device;
  switch (command.type) {
    case 'toggle':
      return 'on' in device ? { ...device, on: !device.on } : device;
    case 'turnOff':
      // 明确关闭（用于“全部关闭”）：已关闭的不变，也就不会发送请求。
      return 'on' in device && device.on ? { ...device, on: false } : device;
    case 'adjust':
      if (!isClimate(device) || !device.on) return device;
      return { ...device, target: Math.min(device.max, Math.max(device.min, device.target + command.delta)) };
    case 'light': {
      const { patch } = command;
      if (device.kind !== 'light' || getLightVariant(device) === 'switch') return device;
      if (patch.colorTemp !== undefined && !supportsColorTemperature(device)) return device;
      if (patch.color !== undefined && !supportsColor(device)) return device;
      const activeColorMode = patch.color !== undefined ? 'color' : patch.colorTemp !== undefined ? 'color_temp' : device.activeColorMode;
      return { ...device, ...patch, activeColorMode, on: true };
    }
    case 'hvacMode':
      if (!isClimate(device) || !device.hvacModes.includes(command.mode) || command.mode === 'off') return device;
      return { ...device, mode: command.mode, on: true };
    case 'fanMode':
      if (!isClimate(device) || !device.on || !device.fanModes?.includes(command.fanMode)) return device;
      return { ...device, fanMode: command.fanMode };
    case 'mediaPower':
      if (device.kind !== 'media' || !device.canPower) return device;
      return { ...device, status: device.status === 'off' ? 'idle' : 'off' };
    case 'mediaPlayPause':
      if (device.kind !== 'media' || !device.canPlayPause || device.status === 'off' || device.status === 'unknown') return device;
      return { ...device, status: device.status === 'playing' ? 'paused' : 'playing' };
    case 'mediaVolume':
      if (device.kind !== 'media' || device.volume === undefined) return device;
      return { ...device, volume: Math.min(100, Math.max(0, command.volume)) };
  }
}
