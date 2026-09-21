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
});
