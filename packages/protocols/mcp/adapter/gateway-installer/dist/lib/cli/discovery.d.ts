export declare function readLaunchctlEnv(name?: any): Promise<any>;
export declare function explicitBaseUrl(options?: Record<string, any>): any;
export declare function baseUrlFromEndpoint(value?: any): any;
export declare function parseScanPorts(options?: Record<string, any>): any;
export declare function registryBaseUrls(options?: Record<string, any>): Promise<any>;
export declare function candidateBaseUrls(options?: Record<string, any>): Promise<any>;
export declare function fetchMeshrixDiscovery(baseUrl?: any): Promise<any>;
export declare function verifyMeshrixHandshake(baseUrl?: any, discovery?: any): Promise<any>;
export declare function discoverMeshrixHub(options?: Record<string, any>): Promise<any>;
export declare function optionsWithDiscoveredBaseUrl(options?: Record<string, any>): Promise<any>;
export declare function publishLaunchctlEnv(env?: any): Promise<any>;
export declare function resolveToken(options?: any, { required }?: Record<string, any>): Promise<any>;
export declare function ensureService(baseUrl?: any): Promise<any>;
export declare function authHeaders(token?: any, target?: any): any;
export declare function signedAuthHeaders({ baseUrl, token, target, method, body, url }?: Record<string, any>): Promise<any>;
export declare function verifyMcpTools({ baseUrl, token, target }: Record<string, any>): Promise<any>;
//# sourceMappingURL=discovery.d.ts.map