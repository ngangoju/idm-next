/**
 * The only bridge between the renderer and Node. Everything else the renderer
 * needs goes over the local HTTP/WS server, so this surface stays tiny: a
 * narrow, explicitly enumerated API is the point of contextIsolation.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('idm', {
  reveal: (filePath: string): Promise<void> => ipcRenderer.invoke('idm:reveal', filePath),
  open: (filePath: string): Promise<string> => ipcRenderer.invoke('idm:open', filePath),
  chooseDir: (): Promise<string | null> => ipcRenderer.invoke('idm:choose-dir'),
  port: (): Promise<number> => ipcRenderer.invoke('idm:port'),
  /** Credential for the local control server; see server.ts on why origin is not enough. */
  token: (): Promise<string> => ipcRenderer.invoke('idm:token'),
  /** Open (or raise) a download's own progress window. */
  openDetail: (id: string): Promise<void> => ipcRenderer.invoke('idm:open-detail', id),
  /** Close this window, if it is a detail window rather than the list. */
  closeSelf: (): Promise<void> => ipcRenderer.invoke('idm:close-self'),
  /** Size this progress window to its content, so it is never taller than it needs. */
  fitHeight: (px: number): Promise<void> => ipcRenderer.invoke('idm:fit-height', px),
});
