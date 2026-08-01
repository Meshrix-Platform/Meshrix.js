export declare const PROCESS_IDENTITY_STORE_ENV: any;
export declare const PROCESS_IDENTITY_WINDOWS_DPAPI_COMMAND_ENV: any;
export declare function supportedProcessIdentitySystemBackendsForPlatform(platform?: any): any;
export declare function resolveWindowsDpapiCommand({ platform, configuredCommand }?: Record<string, any>): any;
export declare function deleteProcessIdentity(target?: any): Promise<any>;
export declare function saveProcessIdentity(target?: any, record?: Record<string, any>): Promise<any>;
export declare function loadProcessIdentity(target?: any): Promise<any>;
//# sourceMappingURL=process-identity-store.d.ts.map