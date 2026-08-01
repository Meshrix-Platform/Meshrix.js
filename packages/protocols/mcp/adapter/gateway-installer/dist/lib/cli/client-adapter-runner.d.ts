export declare const CLIENT_ADAPTER_DESCRIPTOR_SCHEMA: any;
export declare const CLIENT_ADAPTER_MAX_MESSAGE_BYTES: any;
export declare function defaultClientAdapterCacheRoot(): any;
export declare function digestClientAdapterTree(root?: any): Promise<any>;
export declare function acquireClientAdapter({ target, cacheRoot, installPackage }?: Record<string, any>): Promise<any>;
export declare function runClientAdapter({ target, action, request, cacheRoot, installPackage }?: Record<string, any>): Promise<any>;
export declare function clientAdapterConnectorRequest({ baseUrl, tokenEnv, client }?: Record<string, any>): any;
export declare function describeClientAdapter(options?: Record<string, any>): Promise<any>;
//# sourceMappingURL=client-adapter-runner.d.ts.map