import { inject, provide, type InjectionKey } from "vue";

type GatewayReviewConsole = Record<string, unknown>;

const gatewayReviewViewContextKeys: any = [
  "gatewayReviewAnswer",
  "gatewayReviewForm",
  "gatewayReviewPage",
  "gatewayReviewProgress",
  "gatewayReviewTabs",
  "gatewayReviewTrace",
  "gatewayReviewWorkspace",
] as const satisfies readonly string[];

type GatewayReviewViewContextKey = (typeof gatewayReviewViewContextKeys)[number];

export type GatewayReviewViewContext = Pick<GatewayReviewConsole, GatewayReviewViewContextKey>;

export function createGatewayReviewViewContext(debugView: GatewayReviewConsole): GatewayReviewViewContext {
  return Object.fromEntries(gatewayReviewViewContextKeys.map((key?: any) : any => [key, debugView[key]])) as GatewayReviewViewContext;
}

const gatewayReviewViewKey: any = Symbol("gateway-review-view") as InjectionKey<GatewayReviewViewContext>;

export function provideGatewayReviewView(context: GatewayReviewViewContext) : any {
  provide(gatewayReviewViewKey, context);
}

export function useGatewayReviewViewContext() : any {
  const context: any = inject(gatewayReviewViewKey);
  if (!context) {
    throw new Error("Gateway review view context is not available");
  }
  return context;
}
