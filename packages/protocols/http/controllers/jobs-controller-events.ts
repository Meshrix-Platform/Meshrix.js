export async function publishProtocolEvent(protocolEventBus?: any, topic?: any, payload?: any, options: Record<string, any> = {}) : Promise<any> {
  if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
    return null;
  }
  return protocolEventBus.publish(topic, payload, options);
}
