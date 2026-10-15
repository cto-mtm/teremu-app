export interface AppPorts {
  vite: number
  tailscale: number
}

export interface Ports {
  app: AppPorts
  emulators: Record<string, number>
}

export declare const PORTS_FILE: string
export declare const ports: Ports
export declare const app: AppPorts
export declare const emulators: Record<string, number>
export declare function emulatorHost(name: string, host?: string): string
