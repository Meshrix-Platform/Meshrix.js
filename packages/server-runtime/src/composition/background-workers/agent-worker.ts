export async function createAgentWorkerRuntime() : Promise<any> {
  return {
    mode: "standby",
    async tick() : Promise<any> {
      return {
        status: "standby",
        details: {
          mode: "supervised_process_ready",
          note: "该后台角色由守护进程按需托管；智能体是否可用以模型库配置和探测状态为准。"
        }
      };
    },
    async close() : Promise<any> {}
  };
}
