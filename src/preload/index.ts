/**
 * preload: contextBridge で最小 API を renderer へ公開する（contextIsolation 前提）。
 * 型定義は src/shared/types.d.ts の TerminalAppApi を正とする。
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ClickTarget, DropPayload, FocusProjectOptions, OrcaInputPayload, Snapshot, TerminalAppApi, ThemeSetting, WindowAction } from "../shared/types";

const api: TerminalAppApi = {
  getSnapshot: () => ipcRenderer.invoke("get-snapshot"),
  registerProjects: (paths: string[]) => ipcRenderer.invoke("register-projects", paths),
  registerDrop: (payload: DropPayload) => ipcRenderer.invoke("register-drop", payload),
  pickProjects: () => ipcRenderer.invoke("pick-projects"),
  dndLog: (msg: string) => ipcRenderer.send("dnd-log", msg),
  unregisterProject: (id: string) => ipcRenderer.invoke("unregister-project", id),
  setClickTarget: (id: string, target: ClickTarget) => ipcRenderer.invoke("set-click-target", id, target),
  setAllClickTargets: (target: ClickTarget) => ipcRenderer.invoke("set-all-click-targets", target),
  sessionInstructions: (id: string, sessionId?: string) => ipcRenderer.invoke("session-instructions", id, sessionId),
  orcaReadScreen: (id: string, sessionId?: string) => ipcRenderer.invoke("orca-read-screen", id, sessionId),
  orcaSend: (id: string, sessionId: string | undefined, input: OrcaInputPayload) => ipcRenderer.invoke("orca-send", id, sessionId, input),
  setProjectStatus: (id: string, status: string | null) => ipcRenderer.invoke("set-project-status", id, status),
  setCustomStatuses: (list: string[]) => ipcRenderer.invoke("set-custom-statuses", list),
  setProjectName: (id: string, name: string) => ipcRenderer.invoke("set-project-name", id, name),
  setShowUnlinked: (value: boolean) => ipcRenderer.invoke("set-show-unlinked", value),
  // タイルの並び順（260906_1: D&D 並べ替え・自動整列）
  reorderProjects: (ids: string[]) => ipcRenderer.invoke("reorder-projects", ids),
  setTheme: (theme: ThemeSetting) => ipcRenderer.invoke("set-theme", theme),
  setAlwaysOnTopDefault: (value: boolean) => ipcRenderer.invoke("set-aot-default", value),
  setPinned: (value: boolean) => ipcRenderer.invoke("set-pinned", value),
  focusProject: (id: string, options?: FocusProjectOptions) => ipcRenderer.invoke("focus-project", id, options),
  notifyTouchEnded: () => ipcRenderer.send("touch-ended"),
  showTileMenu: (id: string, sessionId?: string) => ipcRenderer.invoke("show-tile-menu", id, sessionId),
  // ウィンドウ位置の一括記憶／復元（260904_1 #3。設定画面のボタンから）
  saveAllWindowBounds: () => ipcRenderer.invoke("save-all-window-bounds"),
  restoreAllWindowBounds: () => ipcRenderer.invoke("restore-all-window-bounds"),
  windowAction: (action: WindowAction) => ipcRenderer.send("window-action", action),
  notifyRendered: (revision: number) => ipcRenderer.send("notify-rendered", revision),
  onSnapshot: (cb: (snap: Snapshot) => void) => {
    ipcRenderer.on("snapshot", (_event, snap: Snapshot) => cb(snap));
  },
  onRenameRequest: (cb: (projectId: string) => void) => {
    ipcRenderer.on("rename-request", (_event, projectId: string) => cb(projectId));
  },
  onOrcaPanelRequest: (cb: (projectId: string, sessionId: string | null) => void) => {
    ipcRenderer.on("orca-panel-request", (_event, projectId: string, sessionId: string | null) => cb(projectId, sessionId));
  },
  // Electron 32+ では File.path が使えないため webUtils で D&D のパスを解決する（REQ-01）
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("terminalApp", api);
