export function descriptor(value: any): any;
export function registrationFrom(request: any): {
    serverName: string;
    baseUrl: string;
    url: string;
    credentialRef: {
        kind: string;
        name: any;
    };
};
export function clientCommand(request: any, fallback: any): string;
export function adapterError(code: any, message: any, exitCode?: number): Error;
export function sanitizedMessage(error: any): string;
export function run(command: any, args?: any[], { allowFailure, input, env }?: {
    allowFailure?: boolean;
    input?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<any>;
export function readJson(filePath: any, fallback?: {}): Promise<any>;
export function parseJsonc(source: any): any;
export function readJsonc(filePath: any, fallback?: {}): Promise<any>;
export function writePrivateFile(filePath: any, content: any): Promise<void>;
export function writeJson(filePath: any, value: any): Promise<void>;
export function homePath(...segments: any[]): string;
export function invokeAdapter(adapter: any, action: any, request?: {}): Promise<any>;
export function runAdapterCli(adapter: any): Promise<void>;
export function isDirectInvocation(metaUrl: any): boolean;
export * from "./native-registration.mjs";
export const ADAPTER_PROTOCOL: "v0.0.1:meshrix:client-adapter-json-stdio-1";
export const ADAPTER_DESCRIPTOR_SCHEMA: "v0.0.1:meshrix:client-adapter-descriptor-1";
export const MCP_SERVER_NAME: "lico";
