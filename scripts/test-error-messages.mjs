import assert from "node:assert/strict";
import { sanitizeNvidiaAsrError } from "../vite.config.mjs";

const dnsMessage = sanitizeNvidiaAsrError(`<_InactiveRpcError of RPC that terminated with:
  status = StatusCode.UNAVAILABLE
  details = "errors resolving grpc.nvcf.nvidia.com:443: Could not contact DNS servers"
>`);
assert.match(dnsMessage, /无法解析或连接/);
assert.doesNotMatch(dnsMessage, /InactiveRpcError|debug_error_string|grpc\.nvcf/);

const authMessage = sanitizeNvidiaAsrError("401 Unauthorized Bearer nvapi-secret-value");
assert.match(authMessage, /鉴权失败/);
assert.doesNotMatch(authMessage, /nvapi-secret-value/);

const dashScopeMessage = sanitizeNvidiaAsrError("DashScope task_status FAILED. upload_host=https://oss-cn-example.aliyuncs.com policy=raw-policy signature=raw-signature");
assert.match(dashScopeMessage, /百炼转写任务未完成/);
assert.doesNotMatch(dashScopeMessage, /raw-policy|raw-signature/);

const endpointMessage = sanitizeNvidiaAsrError("Function ID not found");
assert.match(endpointMessage, /Function ID/);

const audioMessage = sanitizeNvidiaAsrError("invalid audio encoding sample format");
assert.match(audioMessage, /无法识别当前音频输入/);

const inferenceMessage = sanitizeNvidiaAsrError("Internal error while making inference request");
assert.match(inferenceMessage, /上游推理请求未完成/);
assert.doesNotMatch(inferenceMessage, /Internal error/);

const languageMessage = sanitizeNvidiaAsrError("StatusCode.INVALID_ARGUMENT Unavailable model requested given these parameters: language_code=zh; sample_rate=16000; type=offline");
assert.match(languageMessage, /配置未通过语言或音频参数校验/);
assert.match(languageMessage, /系统已阻止启用该配置/);
assert.doesNotMatch(languageMessage, /工作台|源语言/);
assert.doesNotMatch(languageMessage, /请|需要用户|自行/);
assert.doesNotMatch(languageMessage, /INVALID_ARGUMENT|language_code=zh/);

console.log("error message tests passed");
