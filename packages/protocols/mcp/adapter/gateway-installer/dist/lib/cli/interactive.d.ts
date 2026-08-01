export declare function statusGlyph(status?: any): any;
export declare function selectionGlyph(selected?: any): any;
export declare function renderInstallMenu({ candidates, index, selectedIds, baseUrl, message, mode }: Record<string, any>): any;
export declare function renderAutoUpdateMenu({ enabled }: Record<string, any>): any;
export declare function chooseAutoUpdate(): Promise<any>;
export declare function chooseInstallCandidates({ candidates, baseUrl }: Record<string, any>): Promise<any>;
export declare function chooseUninstallCandidates({ candidates, baseUrl }: Record<string, any>): Promise<any>;
export declare function promptLine(prompt?: any, { hidden }?: Record<string, any>): Promise<any>;
export declare function resolveInteractiveToken(options?: any): Promise<any>;
export declare function requestLocalMcpGrant(options?: any, { targets, autoUpdate }?: Record<string, any>): Promise<any>;
export declare function requestLocalMcpGrantBatch(options?: any, { targets, autoUpdate }?: Record<string, any>): Promise<any>;
export declare function notifyLocalMcpUninstall(options?: any, { targets, expectedGrantIds }?: Record<string, any>): Promise<any>;
export declare function finalizeRevokedLocalMcpCredential(target?: any, expectedGrantId?: any): Promise<any>;
export declare function assertProcessIdentityInstallLocation(options?: any, targets?: any): any;
export declare function resolveInstallToken(options?: any, { targets, autoUpdate }?: Record<string, any>): Promise<any>;
export declare function resolveHubForInstall(options?: any): Promise<any>;
export declare function remoteContextFromSettings(settings?: any): any;
//# sourceMappingURL=interactive.d.ts.map