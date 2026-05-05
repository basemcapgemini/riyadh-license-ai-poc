declare module "mammoth/mammoth.browser" {
  export type MammothExtractResult = {
    value: string;
    messages: Array<{
      type: string;
      message: string;
    }>;
  };

  const mammoth: {
    extractRawText(input: {
      arrayBuffer: ArrayBuffer;
    }): Promise<MammothExtractResult>;
  };

  export default mammoth;
}
