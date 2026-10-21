export function nativeCapability(target: any): {
    supported: boolean;
    reasonCode: string;
    reason: any;
    transport?: undefined;
    credentialReferences?: undefined;
    header?: undefined;
} | {
    supported: boolean;
    transport: string;
    credentialReferences: string[];
    header: string;
    reasonCode?: undefined;
    reason?: undefined;
};
export function nativeEntry(target: any, registration: any): {
    url: any;
    env_http_headers: {
        "X-Meshrix.js-Api-Key": any;
    };
    type?: undefined;
    oauth?: undefined;
    headers?: undefined;
    transport?: undefined;
} | {
    type: string;
    url: any;
    oauth: boolean;
    headers: {
        "X-Meshrix.js-Api-Key": string;
    };
    env_http_headers?: undefined;
    transport?: undefined;
} | {
    transport: string;
    url: any;
    headers: {
        "X-Meshrix.js-Api-Key": string;
    };
    env_http_headers?: undefined;
    type?: undefined;
    oauth?: undefined;
} | {
    type: string;
    url: any;
    headers: {
        "X-Meshrix.js-Api-Key": string;
    };
    env_http_headers?: undefined;
    oauth?: undefined;
    transport?: undefined;
} | {
    url: any;
    headers: {
        "X-Meshrix.js-Api-Key": string;
    };
    env_http_headers?: undefined;
    type?: undefined;
    oauth?: undefined;
    transport?: undefined;
};
/** Recognize only the former generated Meshrix proxy, never an arbitrary stdio server. */
export function isOwnedProxy(entry: any, registration: any, target: any): boolean;
export function matchesNativeEntry(entry: any, expected: any): boolean;
export function mergeNativeEntry(entry: any, expected: any, registration: any, target: any): any;
export function jsonRegistrationStore(filePath: any, rootKey: any, serverName: any, read?: typeof readJson): Promise<{
    config: any;
    entry: any;
    save(entry: any): Promise<void>;
}>;
/** Registration only: no network probe, auth-store mutation, credential resolution, or Agent turn. */
export function nativeAdapter({ description, load, probe, beforeInstall }: {
    description: any;
    load: any;
    probe: any;
    beforeInstall: any;
}): {
    description: any;
    scan(request: any): Promise<{
        installed: boolean;
        present: boolean;
        status: string;
        credentialStatus: string;
        connectivity: string;
        capability: {
            supported: boolean;
            reasonCode: string;
            reason: any;
            transport?: undefined;
            credentialReferences?: undefined;
            header?: undefined;
        } | {
            supported: boolean;
            transport: string;
            credentialReferences: string[];
            header: string;
            reasonCode?: undefined;
            reason?: undefined;
        };
        available: any;
        errorCode?: undefined;
    } | {
        installed: boolean;
        status: string;
        capability: {
            supported: boolean;
            reasonCode: string;
            reason: any;
            transport?: undefined;
            credentialReferences?: undefined;
            header?: undefined;
        } | {
            supported: boolean;
            transport: string;
            credentialReferences: string[];
            header: string;
            reasonCode?: undefined;
            reason?: undefined;
        };
        available: any;
        errorCode?: undefined;
        credentialStatus?: undefined;
        connectivity?: undefined;
    } | {
        available: any;
        installed: boolean;
        status: string;
        errorCode: any;
        capability: {
            supported: boolean;
            reasonCode: string;
            reason: any;
            transport?: undefined;
            credentialReferences?: undefined;
            header?: undefined;
        } | {
            supported: boolean;
            transport: string;
            credentialReferences: string[];
            header: string;
            reasonCode?: undefined;
            reason?: undefined;
        };
        credentialStatus: string;
        connectivity: string;
    }>;
    install(request: any): Promise<{
        installed: boolean;
        status: string;
        credentialStatus: string;
        connectivity: string;
    }>;
    verify: (request: any) => Promise<{
        installed: boolean;
        present: boolean;
        status: string;
        credentialStatus: string;
        connectivity: string;
        capability: {
            supported: boolean;
            reasonCode: string;
            reason: any;
            transport?: undefined;
            credentialReferences?: undefined;
            header?: undefined;
        } | {
            supported: boolean;
            transport: string;
            credentialReferences: string[];
            header: string;
            reasonCode?: undefined;
            reason?: undefined;
        };
    }>;
    uninstall(request: any): Promise<{
        removed: boolean;
        installed: boolean;
        credentialsPreserved: boolean;
    }>;
};
export const API_KEY_HEADER: "X-Meshrix.js-Api-Key";
export const NATIVE_AUTH_LIMITATIONS: Readonly<{
    kimi: "Kimi Code documents bearerTokenEnvVar, not an environment reference for X-Meshrix.js-Api-Key. Meshrix rejects Bearer authentication; existing configuration was not changed.";
    antigravity: "Antigravity remote MCP supports headers, but a protected reference for X-Meshrix.js-Api-Key is not qualified. Existing configuration was not changed.";
}>;
import { readJson } from "./index.mjs";
