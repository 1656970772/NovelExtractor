import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedMockOpenAiRequest {
  authorization?: string;
  body: unknown;
  method?: string;
  url?: string;
}

export interface MockOpenAiCompatibleServer {
  baseUrl: string;
  requests: RecordedMockOpenAiRequest[];
  close(): Promise<void>;
}

export interface MockOpenAiCompatibleServerOptions {
  expectedApiKey?: string;
  expectedModel?: string;
  responseContent?: string;
  totalTokens?: number;
}

export const MOCK_OPENAI_COMPATIBLE_RESPONSE_CONTENT = [
  "| 丹药 | 品阶 | 功效 | 材料 | 证据 |",
  "| --- | --- | --- | --- | --- |",
  "| 凝气丹 | 炼气初期 | 补气、护脉 | 青灵草、白玉砂、寒潭水 | mock server 第一章 |",
  "",
  "安全预览边界：<script>window.e2eUnsafe = true</script>",
  "",
  "[危险链接](javascript:alert(1))"
].join("\n");

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startMockOpenAiCompatibleServer(
  options: MockOpenAiCompatibleServerOptions = {}
): Promise<MockOpenAiCompatibleServer> {
  const expectedApiKey = options.expectedApiKey ?? "sk-e2e-mock";
  const expectedModel = options.expectedModel ?? "mock-model";
  const responseContent = options.responseContent ?? MOCK_OPENAI_COMPATIBLE_RESPONSE_CONTENT;
  const totalTokens = options.totalTokens ?? 128;
  const requests: RecordedMockOpenAiRequest[] = [];

  const server = createServer(async (request, response) => {
    const bodyText = await readRequestBody(request);
    const body = bodyText ? JSON.parse(bodyText) : {};
    requests.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      url: request.url
    });

    response.setHeader("Content-Type", "application/json");

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "unexpected path" }));
      return;
    }

    if (request.headers.authorization !== `Bearer ${expectedApiKey}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "unexpected authorization" }));
      return;
    }

    if (body.model !== expectedModel) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: `unexpected model ${String(body.model)}` }));
      return;
    }

    response.writeHead(200);
    response.end(
      JSON.stringify({
        choices: [{ message: { content: responseContent } }],
        usage: {
          prompt_tokens: 39,
          completion_tokens: totalTokens - 39,
          total_tokens: totalTokens
        }
      })
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeServer(server)
  };
}
