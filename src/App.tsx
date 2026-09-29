import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Eye, Pencil, Snowflake, Sun, Power, RotateCcw, Settings, Star } from 'lucide-react';
import { AdaptiveGrid } from './components/AdaptiveGrid';
import { ActiveDevicesDialog } from './components/ActiveDevicesDialog';
import type { ActiveListRequest } from './components/ActiveDevicesDialog';
import { ClimateDialog } from './components/ClimateDialog';
import { ConnectionBadge } from './components/ConnectionBadge';
import { DeviceCard, EmptyRoomCard } from './components/DeviceCards';
import type { TilePlacement } from './components/DeviceCards';
import { HomeStatusSummary } from './components/HomeStatusSummary';
import { RoomOrderDialog } from './components/RoomOrderDialog';
import { RoomScene } from './components/RoomScene';
import { RoomStatusSummary } from './components/RoomStatusSummary';
import { PinDialog } from './components/PinDialog';
import { SettingsPage } from './components/SettingsPage';
import { SideNav } from './components/SideNav';
import { WeatherCompact, WeatherDialog, WeatherHero } from './components/Weather';
import { login, logout, putLayout } from './consoleApi';
import { allowedSizesForDevice, favoriteIds, favoriteSizeKey, fromServerLayout, layoutKey, orderedDevices, orderedRooms, readLayout, saveLayout, tileSizeForDevice, toServerLayout, toggleFavorite } from './layout';
import { getRoomDevices, isClimate, isLit, isRunning, sortRunning } from './selectors';
import { formatDate, homeGreeting, useNow } from './time';
import type { Device, DeviceActions, LayoutState, Room, TileSize } from './types';
import { useConsole } from './useConsole';
import { readOnlyActions, useHome } from './useHome';
import { useTileDrag } from './useTileDrag';
import { useWeather } from './useWeather';
import { weatherIcon } from './weather';
import { applyAccent, applyTheme, resolveTheme } from './theme';
import { usePageSwipe } from './usePageSwipe';

type Page = 'home' | 'room' | 'settings';

/** 拖动与键盘排序的作用域：常用设备，或某个房间 id。 */
const favoritesScope = 'favorites';

function presentDevices(devices: Device[], ids: string[]): Device[] {
  return ids.map((id) => devices.find((device) => device.id === id)).filter((device): device is Device => Boolean(device));
}

function App() {
  const server = useConsole();
  const live = server.status?.dataSource === 'live';
  const { home: sourceHome, runningIds, actions: deviceActions, refreshRunning, reset, notice, clearNotice } = useHome(
    live ? { entityStates: server.entityStates, catalogue: server.catalogue, callService: server.callService } : null,
  );
  const [page, setPage] = useState<Page>('home');
  const [selectedRoomId, setSelectedRoomId] = useState('living');
  const [selectedClimateId, setSelectedClimateId] = useState<string | null>(null);
  const [editingLayout, setEditingLayout] = useState(false);
  const [layout, setLayout] = useState<LayoutState>(readLayout);
  const [roomOrderOpen, setRoomOrderOpen] = useState(false);
  // 房间按共用布局排序；导航、默认房间和“正在运行”的同类排序都使用这个顺序。
  const home = useMemo(() => ({ ...sourceHome, rooms: orderedRooms(sourceHome.rooms, layout.rooms) }), [sourceHome, layout.rooms]);
  const [pinOpen, setPinOpen] = useState(false);
  const [appNotice, setAppNotice] = useState<string | null>(null);
  // 最近一次与后端一致的布局；为 null 表示还没收到后端布局，此前不上传本地缓存，避免旧缓存覆盖共用布局。
  const syncedLayoutRef = useRef<string | null>(null);
  const previousPageRef = useRef<Page>('home');
  const drag = useTileDrag(reorder);
  const now = useNow();
  const weather = useWeather();
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [activeList, setActiveList] = useState<ActiveListRequest | null>(null);
  // “正在运行”的全部关闭需要二次确认：第一次点击进入确认状态，3 秒内再点才执行。
  const [confirmAllOff, setConfirmAllOff] = useState(false);
  useEffect(() => {
    if (!confirmAllOff) return;
    const timer = window.setTimeout(() => setConfirmAllOff(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmAllOff]);
  /** 页面切换方向：1 从下方进入（导航中往下），-1 从上方进入，0 淡入。 */
  const [enterDirection, setEnterDirection] = useState<-1 | 0 | 1>(0);
  // 主题：服务端设置的模式 + 本屏的日出日落（自动模式），每 15 秒随时钟重新计算，变化时才应用。
  const themeMode = server.status?.theme;
  const theme = themeMode ? resolveTheme(themeMode, now, weather.forecast) : null;
  useEffect(() => { if (theme) applyTheme(theme); }, [theme]);
  const accent = server.status?.accent;
  useEffect(() => { if (accent) applyAccent(accent); }, [accent]);

  // 后端推来的共用布局（首次连接或其他屏幕修改后）直接采用。
  useEffect(() => {
    if (!server.layout) return;
    const next = fromServerLayout(server.layout);
    syncedLayoutRef.current = layoutKey(next);
    setLayout(next);
  }, [server.layout]);

  // 本地修改：先写缓存，再合并 400ms 后保存到后端；与后端一致时不重复上传。
  useEffect(() => {
    saveLayout(layout);
    if (!server.connected || syncedLayoutRef.current === null || layoutKey(layout) === syncedLayoutRef.current) return;
    const timer = window.setTimeout(() => {
      putLayout(toServerLayout(layout))
        .then((saved) => { syncedLayoutRef.current = layoutKey(fromServerLayout(saved)); })
        .catch((error: Error) => setAppNotice(`布局未保存：${error.message}`));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [layout, server.connected]);

  // 离开设置页即退出管理登录，下次进入需重新输入密码。
  useEffect(() => {
    if (previousPageRef.current === 'settings' && page !== 'settings') void logout();
    previousPageRef.current = page;
  }, [page]);

  const toast = notice ?? appNotice;
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => { clearNotice(); setAppNotice(null); }, 6000);
    return () => window.clearTimeout(timer);
  }, [toast, clearNotice]);

  const settingsExpired = useCallback((message: string) => {
    setAppNotice(message);
    setPage('home');
  }, []);

  // 只读模式下设备按钮仍可点，但操作被替换为空操作；编辑布局入口一并隐藏。后端同样会拒绝控制与布局修改。
  const canControl = server.status?.controlEnabled ?? true;
  const baseActions = canControl ? deviceActions : readOnlyActions;
  // 季节规则（设置 → 自动化）：夏季不打开地暖；打开空调时直接用当季的模式，免得先开成相反模式再被 HA 自动化改回来。
  const season = server.status?.season ?? null;
  const actions: DeviceActions = canControl && season ? {
    ...baseActions,
    toggle: (id) => {
      const device = home.devices.find((item) => item.id === id);
      if (device && isClimate(device) && device.available && !device.on) {
        if (device.kind === 'heating' && season === 'summer') {
          setAppNotice(`${device.name}：夏季不能打开地暖，可在 设置 → 自动化 切换季节`);
          return;
        }
        const wrong = season === 'summer' ? 'heat' : 'cool';
        const right = season === 'summer' ? 'cool' : 'heat';
        if (device.kind === 'climate' && device.mode === wrong && device.hvacModes.includes(right)) {
          baseActions.changeClimateMode(id, right);
          return;
        }
      }
      baseActions.toggle(id);
    },
    changeClimateMode: (id, mode) => {
      const device = home.devices.find((item) => item.id === id);
      if (device?.kind === 'heating' && season === 'summer' && mode !== 'off') {
        setAppNotice(`${device.name}：夏季不能打开地暖，可在 设置 → 自动化 切换季节`);
        return;
      }
      baseActions.changeClimateMode(id, mode);
    },
  } : baseActions;

  // HA 模式下房间来自自动发现，目录到达前可能一个房间都没有。
  const selectedRoom: Room = home.rooms.find((room) => room.id === selectedRoomId) ?? home.rooms[0] ?? { id: '', name: '房间', category: 'main' };
  const selectedRoomDevices = useMemo(() => orderedDevices(getRoomDevices(home, selectedRoom.id), layout.order[selectedRoom.id]), [home, selectedRoom.id, layout.order]);
  const selectedRoomLitCount = selectedRoomDevices.filter(isLit).length;
  const selectedClimate = home.devices.filter(isClimate).find((device) => device.id === selectedClimateId);
  const roomOf = (device: Device): Room => home.rooms.find((room) => room.id === device.roomId) ?? selectedRoom;
  const favorites = favoriteIds(layout);
  const favoriteDevices = presentDevices(home.devices, favorites);
  const runningDevices = sortRunning(home, presentDevices(home.devices, runningIds));
  const runningNow = runningDevices.filter(isRunning).length;
  // 常用卡片本身显示开关状态，“正在运行”只列常用里没有的设备，避免同一设备出现两次；标题仍计全屋运行总数。
  const runningOthers = runningDevices.filter((device) => !favorites.includes(device.id));
  const runningInFavorites = runningDevices.filter((device) => isRunning(device) && favorites.includes(device.id)).length;
  // 全部关闭只针对这一区列出的灯、空调、地暖；播放器和常用区的设备不动。
  const allOffTargets = runningOthers.filter((device) => 'on' in device && device.available && device.on);
  const homeTitle = server.status?.homeTitle || '我的家庭';
  const tileScale = (server.status?.tileScale ?? 100) / 100;
  const homeSubtitle = server.status?.homeSubtitle ?? '常用设备与正在运行的设备，一眼看清';
  // 全屋页页头按当前天气着色，其他页面保持中性。
  const heroTone = page === 'home' && weather.forecast ? weatherIcon(weather.forecast.now.icon).tone : null;

  function reorder(scope: string, order: string[]) {
    setLayout((previous) => scope === favoritesScope ? { ...previous, favorites: order } : { ...previous, order: { ...previous.order, [scope]: order } });
  }

  function changeRoomOrder(ids: string[]) {
    setLayout((previous) => ({ ...previous, rooms: ids }));
  }

  function leaveLayoutEditing() {
    setEditingLayout(false);
    drag.cancel();
  }

  /** 按导航顺序判断切换方向：往导航下方走，新页面从下方进入。 */
  function directionTo(key: string): -1 | 0 | 1 {
    const target = navTargets.findIndex((item) => item.key === key);
    if (currentNavIndex < 0 || target < 0) return 0;
    return Math.sign(target - currentNavIndex) as -1 | 0 | 1;
  }

  function openRoom(id: string) {
    setEnterDirection(directionTo(id));
    setSelectedRoomId(id);
    leaveLayoutEditing();
    setPage('room');
  }

  function openHome() {
    setEnterDirection(directionTo('home'));
    refreshRunning();
    leaveLayoutEditing();
    setPage('home');
  }

  /** 齿轮先弹出管理密码框，验证通过才进入设置页。 */
  function requestSettings() {
    if (page !== 'settings') setPinOpen(true);
  }

  function openSettings() {
    setEnterDirection(0);
    leaveLayoutEditing();
    setSelectedClimateId(null);
    setPage('settings');
  }

  function changeSize(id: string, size: TileSize) {
    setLayout((previous) => ({ ...previous, sizes: { ...previous.sizes, [id]: size } }));
  }

  function changeFavorite(id: string) {
    setLayout((previous) => toggleFavorite(previous, id));
  }

  /** 当前页可排序的设备：全屋页为常用设备，房间页为该房间设备。 */
  function sortable(): { scope: string; ids: string[] } {
    const devices = page === 'home' ? favoriteDevices : selectedRoomDevices;
    return { scope: page === 'home' ? favoritesScope : selectedRoom.id, ids: devices.map((device) => device.id) };
  }

  function moveDevice(id: string, direction: -1 | 1) {
    const { scope, ids } = sortable();
    const index = ids.indexOf(id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    reorder(scope, ids);
  }

  function startDrag(id: string, event: PointerEvent<HTMLElement>) {
    if (!editingLayout) return;
    const { scope, ids } = sortable();
    drag.start(id, scope, ids, event);
  }

  /** 编辑布局时共用的排序属性。 */
  function editingTile(device: Device, index: number, total: number): Omit<TilePlacement, 'size'> {
    return {
      editing: editingLayout,
      index,
      total,
      onMove: moveDevice,
      onDragStart: startDrag,
      onFavoriteToggle: changeFavorite,
      favorite: favorites.includes(device.id),
      dragging: drag.view?.id === device.id,
      dropTarget: drag.view?.overId === device.id,
      dragOffset: drag.view?.id === device.id ? drag.view : undefined,
    };
  }

  function resetDemo() {
    reset();
    setSelectedClimateId(null);
  }

  function card(device: Device, room: Room, tile: TilePlacement) {
    return <DeviceCard key={device.id} device={device} room={room} tile={tile} actions={actions} onOpenClimate={setSelectedClimateId} seasonLock={season === 'summer' && device.kind === 'heating' ? '夏季停用' : undefined} />;
  }

  /** 常用区卡片可在“编辑”里切换 1×1／2×1，尺寸单独保存，不影响房间里的同一设备。 */
  function favoriteCard(device: Device, index: number) {
    return card(device, roomOf(device), {
      size: tileSizeForDevice(device, layout.sizes[favoriteSizeKey(device.id)]),
      onSizeChange: (id, size) => changeSize(favoriteSizeKey(id), size),
      ...editingTile(device, index, favoriteDevices.length),
    });
  }

  /** “正在运行”用于查看和顺手关掉，统一用单格；只能双格的（播放器）保持默认。 */
  function runningCard(device: Device) {
    return card(device, roomOf(device), { size: allowedSizesForDevice(device).includes('1x1') ? '1x1' : tileSizeForDevice(device) });
  }

  function turnOffRunning() {
    if (!confirmAllOff) {
      setConfirmAllOff(true);
      return;
    }
    setConfirmAllOff(false);
    allOffTargets.forEach((device) => actions.turnOff(device.id));
  }

  function roomCard(device: Device, index: number) {
    return card(device, selectedRoom, {
      size: tileSizeForDevice(device, layout.sizes[device.id]),
      onSizeChange: changeSize,
      ...editingTile(device, index, selectedRoomDevices.length),
    });
  }

  // 右侧内容区上下滑动切换左侧导航：顺序与导航一致（首页、房间、其他空间）。
  const navTargets = [
    { key: 'home', label: homeTitle },
    ...[...home.rooms.filter((room) => room.category === 'main'), ...home.rooms.filter((room) => room.category === 'other')].map((room) => ({ key: room.id, label: room.name })),
  ];
  const currentNavIndex = page === 'home' ? 0 : page === 'room' ? navTargets.findIndex((target) => target.key === selectedRoom.id) : -1;
  const swipeEnabled = currentNavIndex >= 0 && !editingLayout && !weatherOpen && !activeList && !selectedClimate && !roomOrderOpen && !pinOpen;
  const swipeHint = usePageSwipe(
    swipeEnabled,
    currentNavIndex > 0 ? navTargets[currentNavIndex - 1] : null,
    currentNavIndex >= 0 && currentNavIndex < navTargets.length - 1 ? navTargets[currentNavIndex + 1] : null,
    (key) => {
      if (key === 'home') openHome();
      else openRoom(key);
      window.scrollTo({ top: 0 });
    },
  );

  // 页面切换动画：页头文字与内容按方向进入；滑动时两者跟随手指（用 translate，不与进入动画的 transform 冲突）。
  const pageKey = page === 'room' ? `room-${selectedRoom.id}` : page;
  const enterClass = `page-enter page-enter--${enterDirection === 1 ? 'up' : enterDirection === -1 ? 'down' : 'fade'}`;
  const dragStyle = swipeHint ? { translate: `0 ${swipeHint.offset.toFixed(1)}px` } : undefined;

  const editButton = (
    <button type="button" className={`small-button${editingLayout ? ' small-button--selected' : ''}`} onClick={() => editingLayout ? leaveLayoutEditing() : setEditingLayout(true)}>
      <Pencil size={15} />{editingLayout ? '完成' : page === 'home' ? '编辑' : '编辑布局'}
    </button>
  );

  return (
    <div className={`app-shell${swipeHint ? ' app-shell--dragging' : ''}`}>
      <SideNav home={home} homeTitle={homeTitle} current={page === 'room' ? { roomId: selectedRoom.id } : page} now={now} onHome={openHome} onOpenRoom={openRoom} onSettings={requestSettings} onEditRooms={canControl ? () => setRoomOrderOpen(true) : undefined} />
      <header className={`hero${page === 'home' ? ' hero--home' : ''}${page === 'settings' ? ' hero--settings' : ''}${heroTone ? ` hero--weather weather--${heroTone}` : ''}`}>
        {page === 'room' && <RoomScene key={selectedRoom.id} room={selectedRoom} lit={selectedRoomLitCount > 0} />}
        <div className="hero__top">
          <span className="hero__brand">{homeGreeting(now)}<span className="hero__brand-date"> · {formatDate(now)}</span></span>
          <div className="hero__actions">
            {!canControl && <span className="demo-flag demo-flag--readonly"><Eye size={14} />只读模式</span>}
            <ConnectionBadge quiet={page !== 'home'} connected={server.connected} status={server.status} staleSince={server.staleSince} offlineSince={server.offlineSince} now={now} />
            {!live && <button type="button" className="text-button" onClick={resetDemo} aria-label="重置演示设备状态"><RotateCcw size={15} />重置演示</button>}
            <button type="button" className="icon-button hero__settings" onClick={requestSettings} aria-current={page === 'settings' ? 'page' : undefined} aria-label="设置" title="设置"><Settings size={18} /></button>
          </div>
        </div>
        <div className={`hero__body ${enterClass}`} key={pageKey} style={dragStyle}>
          <div className="hero__main">
            <div className="hero__title">
              <div>
                <h1>{page === 'room' ? selectedRoom.name : page === 'settings' ? '设置' : homeTitle}{page === 'home' && season && <span className={`season-badge season-badge--${season}`} title="季节规则（设置 → 自动化）">{season === 'summer' ? <Sun size={14} /> : <Snowflake size={14} />}{season === 'summer' ? '夏季' : '冬季'}</span>}</h1>
                {(page !== 'home' || homeSubtitle) && <p>{page === 'room' ? '房间状态与设备控制' : page === 'settings' ? '管理密码、Home Assistant 连接与控制权限' : homeSubtitle}</p>}
              </div>
              {page === 'home' && <WeatherCompact weather={weather} onOpen={() => setWeatherOpen(true)} />}
            </div>
            {page === 'room' && <RoomStatusSummary home={home} roomId={selectedRoom.id} onOpen={setActiveList} />}
            {page === 'home' && <HomeStatusSummary home={home} onOpen={setActiveList} />}
          </div>
        </div>
        {page === 'home' && <WeatherHero weather={weather} now={now} onOpen={() => setWeatherOpen(true)} />}
      </header>

      <main className={`main-content ${enterClass}`} key={pageKey} style={dragStyle}>
        {page === 'home' && (
          <>
            <div className="section-heading">
              <h2>常用设备<em>{favoriteDevices.length}</em></h2>
              <div className="section-heading__actions">
                <span>{!canControl ? '只读模式，设备操作不会执行' : editingLayout ? '拖动调整顺序，右下角切换尺寸，点 ★ 移出常用' : '在房间“编辑布局”里点 ☆ 加入常用'}</span>
                {canControl && (favoriteDevices.length > 0 || editingLayout) && editButton}
              </div>
            </div>
            {favoriteDevices.length > 0
              ? <AdaptiveGrid className="tile-grid tile-grid--quick" scale={tileScale}>{favoriteDevices.map(favoriteCard)}</AdaptiveGrid>
              : <div className="empty-room"><span className="tile__chip"><Star size={20} /></span><p>还没有常用设备。进入房间点“编辑布局”，给设备点 ☆ 即可加入。</p></div>}
            <div className="section-heading section-heading--spaced">
              <h2>正在运行<em>{runningNow}</em></h2>
              <div className="section-heading__actions">
                {runningInFavorites > 0 && <span>{runningOthers.length > 0 ? `其中 ${runningInFavorites} 个在常用设备中` : `都在上方常用设备中`}</span>}
                {canControl && allOffTargets.length > 0 && (
                  <button type="button" className={`small-button${confirmAllOff ? ' small-button--danger' : ''}`} onClick={turnOffRunning} title="关闭下方列出的灯、空调、地暖（播放器与常用设备不动）">
                    <Power size={15} />{confirmAllOff ? `确认关闭 ${allOffTargets.length} 个` : '全部关闭'}
                  </button>
                )}
              </div>
            </div>
            {runningOthers.length > 0
              ? <AdaptiveGrid className="tile-grid tile-grid--running" scale={tileScale}>{runningOthers.map(runningCard)}</AdaptiveGrid>
              : runningNow === 0 && <div className="empty-room"><span className="tile__chip"><Power size={20} /></span><p>目前没有打开的设备。</p></div>}
          </>
        )}
        {page === 'room' && (
          <>
            <div className="section-heading">
              <h2>设备与状态<em>{selectedRoomDevices.length}</em></h2>
              <div className="section-heading__actions">
                {selectedRoomLitCount > 0 && <span className="section-heading__lit">{selectedRoomLitCount} 盏灯亮</span>}
                {canControl && editButton}
              </div>
            </div>
            {selectedRoomDevices.length > 0
              ? <AdaptiveGrid className="tile-grid tile-grid--room" scale={tileScale}>{selectedRoomDevices.map(roomCard)}</AdaptiveGrid>
              : <EmptyRoomCard name={selectedRoom.name} />}
          </>
        )}
        {page === 'settings' && <SettingsPage status={server.status} onLock={openHome} onExpired={settingsExpired} />}
      </main>

      <RoomOrderDialog open={roomOrderOpen && canControl} rooms={home.rooms} onChange={changeRoomOrder} onClose={() => setRoomOrderOpen(false)} />
      {pinOpen && <PinDialog onSubmit={login} onUnlock={openSettings} onClose={() => setPinOpen(false)} />}
      {toast && <div className="toast" role="alert" onClick={() => { clearNotice(); setAppNotice(null); }}>{toast}</div>}
      <ActiveDevicesDialog request={activeList} home={home} actions={actions} canControl={canControl} onClose={() => setActiveList(null)} />
      <WeatherDialog open={weatherOpen} weather={weather} now={now} onClose={() => setWeatherOpen(false)} />
      <ClimateDialog climate={selectedClimate} room={selectedClimate && roomOf(selectedClimate)} actions={actions} onClose={() => setSelectedClimateId(null)} />
    </div>
  );
}

export default App;
