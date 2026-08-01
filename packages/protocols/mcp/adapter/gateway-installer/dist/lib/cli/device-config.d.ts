export declare function buildDeviceHubManifest({ baseUrl, targets, tokenEnv, discoveryPath }: Record<string, any>): any;
export declare function publishDeviceHubManifest({ baseUrl, targets, tokenEnv, publishEnv, discoveryPath }: Record<string, any>): Promise<any>;
export declare function writeDeviceDiscovery({ baseUrl, installed, token, tokenEnv, publishEnv, discoveryPath }: Record<string, any>): Promise<any>;
export declare function writeDeviceUninstall({ baseUrl, uninstalled, tokenEnv, publishEnv, discoveryPath }: Record<string, any>): Promise<any>;
export declare function defaultTargetStatuses(existingTargets?: Record<string, any>): any;
export declare function profileFromDiscovery({ name, discovered }: Record<string, any>): any;
export declare function existingManifestTokenEnv(server?: Record<string, any>): any;
export declare function writeServerConfigProfile({ options, name, discovered, publishEnv }: Record<string, any>): Promise<any>;
export declare function resetServerConfig({ options, publishEnv }: Record<string, any>): Promise<any>;
export declare function serverConfigCommand(options?: any): Promise<any>;
//# sourceMappingURL=device-config.d.ts.map