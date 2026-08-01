export declare function shellCommandForInstall({ target, includeUrl, baseUrl, includeToken, tokenEnv }?: Record<string, any>): any;
export declare function commandGuidanceBaseUrl(options?: Record<string, any>): any;
export declare function commandGuidanceContext(options?: Record<string, any>): any;
export declare function appendGuidanceContextArgs(parts?: any, { baseUrl, tokenEnv, includeUrl }?: Record<string, any>): any;
export declare function shellCommandForScan({ includeUrl, baseUrl, tokenEnv }?: Record<string, any>): any;
export declare function shellCommandForDiscoverLocal({ includeUrl, baseUrl }?: Record<string, any>): any;
export declare function shellCommandForDoctor({ includeToken, includeUrl, baseUrl, tokenEnv }?: Record<string, any>): any;
export declare function shellCommandForUninstall({ target, includeUrl, baseUrl }?: Record<string, any>): any;
export declare function shellCommandForServerConfig({ baseUrl }?: Record<string, any>): any;
export declare function githubOneLineInstallGuidance({ includeUrl, baseUrl, tokenEnv }?: Record<string, any>): any;
export declare function installGuidanceMetadata({ includeUrl, baseUrl, tokenEnv }?: Record<string, any>): any;
export declare function commandFailureGuidance({ command, message, options }?: Record<string, any>): any;
export declare function commandOptionArgs(options?: Record<string, any>): any;
export declare function candidateInstallCommand(candidate?: any, settings?: any): any;
export declare function candidateRepairCommand(candidate?: any, settings?: any): any;
export declare function candidateDoctorCommand(settings?: any): any;
export declare function withInstallCandidateGuidance(candidate?: any, settings?: any): any;
export declare function doctorGuidance(checks?: Record<string, any>, options?: Record<string, any>): any;
//# sourceMappingURL=guidance.d.ts.map