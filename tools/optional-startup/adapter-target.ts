function adapterError(code: string) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  return error;
}

export async function loadOptionalAdapterTarget(options: Record<string, any>) : Promise<any> {
  const loaded: any = await options.load();
  if (loaded?.description?.target !== options.adapterTarget || !loaded?.adapter) {
    throw adapterError("optional_startup_adapter_contract_invalid");
  }
  return Object.freeze({ id: options.id, kind: "adapter", status: "loaded" });
}
