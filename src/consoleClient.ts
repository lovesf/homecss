/**
 * 与控制台后端（home-console/server）的 WebSocket 连接。
 * 后端保管 HA 令牌并持有唯一的 HA 连接，自动发现设备并按黑白名单过滤；浏览器只接收目录、状态和布局，按实体请求控制。
 */
import type { Accent } from './theme';
import type { LayoutState } from './types';

export type Season = 'summer' | 'winter';

export interface EntityState {
  state: string;
  attributes: Record<string, unknown>;
}

/** 后端自动发现并过滤后的实体；areaId 为 null 表示未分配区域。 */
export interface CatalogueEntity {
  id: string;
  domain: string;
  deviceClass: string | null;
  areaId: string | null;
  name: string;
  /** 传感器在 HA 中的显示小数位（用户设置优先，其次集成建议）；没有时为 undefined。 */
  precision?: number;
}

export interface Catalogue {
  rooms: { id: string; name: string }[];
  entities: CatalogueEntity[];
}

export type HaStatus =
  | { kind: 'disabled' }
  | { kind: 'unconfigured' }
  | { kind: 'connecting' }
  | { kind: 'connected'; version?: string }
  | { kind: 'auth_failed'; message: string }
  | { kind: 'disconnected'; message: string; retryInSeconds: number };

export interface ServerStatus {
  dataSource: 'demo' | 'live';
  controlEnabled: boolean;
  /** “我的家庭”页标题与副标题（设置 → 显示），所有屏幕共用；副标题为空表示不显示。 */
  homeTitle?: string;
  homeSubtitle?: string;
  /** 主题模式（设置 → 显示）：自动为日出到日落浅色。 */
  theme?: 'dark' | 'light' | 'auto';
  /** 设备格子缩放百分比（设置 → 显示，80–120），所有屏幕共用；旧服务没有时按 100。 */
  tileScale?: number;
  /** 强调色（设置 → 显示），所有屏幕共用；旧服务没有时按琥珀。 */
  accent?: Accent;
  /** 季节（设置 → 自动化 → 季节规则）；未启用季节规则时为 null。 */
  season?: Season | null;
  ha: HaStatus;
}

/** 后端布局中 favorites 为 null 表示使用默认常用清单。 */
export type ServerLayout = Omit<LayoutState, 'favorites' | 'rooms'> & { favorites: string[] | null; rooms?: string[] };

type ServerMessage =
  | { type: 'hello'; catalogue: Catalogue; layout: ServerLayout }
  | ({ type: 'status' } & ServerStatus)
  | { type: 'entities'; changed: Record<string, EntityState | null>; snapshot?: boolean }
  | { type: 'layout'; layout: ServerLayout }
  | { type: 'catalogue'; catalogue: Catalogue }
  | { type: 'result'; id: number; success: boolean; error?: string | null }
  | { type: 'pong' };

interface ConsoleClientHandlers {
  onConnection: (connected: boolean) => void;
  onHello: (catalogue: Catalogue, layout: ServerLayout) => void;
  onStatus: (status: ServerStatus) => void;
  onEntities: (changed: Record<string, EntityState | null>, snapshot: boolean) => void;
  onLayout: (layout: ServerLayout) => void;
  onCatalogue: (catalogue: Catalogue) => void;
}

const retryDelays = [1, 2, 5, 10, 30];
const callTimeoutMs = 15_000;
/** 手机解锁后网络可能还没就绪，新连接卡在建立阶段时超时重试。 */
const connectTimeoutMs = 8_000;
const offlineMessage = '正在重新连接，操作未发送';
/** 已发出但连接中断、没收到结果的请求：可能已执行，也可能没有，重连后以设备状态为准。 */
const interruptedMessage = '连接中断，结果未知，请以设备状态为准';
/** 定时确认连接可用：发 ping，超时未收到 pong 视为连接已失效并立即重连。 */
const keepaliveMs = 25_000;
const pongTimeoutMs = 5_000;

export class ConsoleClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: number }>();
  private retryIndex = 0;
  private retryTimer = 0;
  private connectTimer = 0;
  private keepaliveTimer = 0;
  private pongTimer = 0;
  private closed = false;

  constructor(private readonly handlers: ConsoleClientHandlers) {}

  connect() {
    this.closed = false;
    this.open();
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.connectTimer);
    this.stopKeepalive();
    this.rejectPending('连接已关闭');
    this.socket?.close();
    this.socket = null;
  }

  /**
   * 页面回到前台、网络恢复时调用：没有可用连接就立即重连（不再等退避计时），连接看似正常则立即确认一次；
   * force 时直接重建，手机锁屏较久后旧连接可能已失效却未报告关闭。
   */
  wake(force = false) {
    if (this.closed) return;
    const socket = this.socket;
    if (socket && !force) {
      if (socket.readyState === WebSocket.OPEN) { this.ping(); return; }
      if (socket.readyState === WebSocket.CONNECTING) return;
    }
    window.clearTimeout(this.retryTimer);
    this.retryIndex = 0;
    if (socket) {
      // 先解除引用，旧连接的关闭事件不再触发重试或断线状态，页面继续显示已有数据直到新连接送来快照。
      this.socket = null;
      this.stopKeepalive();
      this.rejectPending(interruptedMessage);
      socket.close();
    }
    this.open();
  }

  private ping() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.pongTimer) return;
    this.pongTimer = window.setTimeout(() => {
      this.pongTimer = 0;
      if (this.socket === socket) this.dropDeadSocket(socket);
    }, pongTimeoutMs);
    socket.send(JSON.stringify({ type: 'ping' }));
  }

  /** 连接已失效但浏览器还没报告关闭：不等关闭握手，直接按断线处理并立即重连。 */
  private dropDeadSocket(socket: WebSocket) {
    this.socket = null;
    this.stopKeepalive();
    this.rejectPending(interruptedMessage);
    this.handlers.onConnection(false);
    socket.close();
    if (!this.closed) this.open();
  }

  private stopKeepalive() {
    window.clearInterval(this.keepaliveTimer);
    window.clearTimeout(this.pongTimer);
    this.keepaliveTimer = 0;
    this.pongTimer = 0;
  }

  /** 请求控制某个实体；后端校验实体可见、服务与参数在白名单内。 */
  callService(entity: string, service: string, data: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(offlineMessage));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error('响应超时')); }, callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, type: 'call_service', entity, service, data }));
    });
  }

  private open() {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
    this.socket = socket;
    window.clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) socket.close();
    }, connectTimeoutMs);
    socket.onopen = () => {
      window.clearTimeout(this.connectTimer);
      this.stopKeepalive();
      this.keepaliveTimer = window.setInterval(() => this.ping(), keepaliveMs);
      this.retryIndex = 0;
      this.handlers.onConnection(true);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      this.handle(message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      window.clearTimeout(this.connectTimer);
      this.stopKeepalive();
      this.rejectPending(interruptedMessage);
      this.handlers.onConnection(false);
      if (this.closed) return;
      const delay = retryDelays[Math.min(this.retryIndex, retryDelays.length - 1)];
      this.retryIndex += 1;
      this.retryTimer = window.setTimeout(() => this.open(), delay * 1000);
    };
  }

  private handle(message: ServerMessage) {
    switch (message.type) {
      case 'hello': this.handlers.onHello(message.catalogue, message.layout); return;
      case 'status': this.handlers.onStatus({ dataSource: message.dataSource, controlEnabled: message.controlEnabled, homeTitle: message.homeTitle, homeSubtitle: message.homeSubtitle, theme: message.theme, tileScale: message.tileScale, accent: message.accent, season: message.season, ha: message.ha }); return;
      case 'catalogue': this.handlers.onCatalogue(message.catalogue); return;
      case 'entities': this.handlers.onEntities(message.changed, Boolean(message.snapshot)); return;
      case 'layout': this.handlers.onLayout(message.layout); return;
      case 'pong': window.clearTimeout(this.pongTimer); this.pongTimer = 0; return;
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        window.clearTimeout(pending.timer);
        if (message.success) pending.resolve();
        else pending.reject(new Error(message.error || '操作失败'));
      }
    }
  }

  private rejectPending(reason: string) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
