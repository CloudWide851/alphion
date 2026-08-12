export { createDesktopHost } from "./host.js";
export type { DesktopHost, DesktopTransport } from "./host.js";
export { StdioJsonlTransport } from "./stdio.js";
export { runDesktopHost } from "./main.js";
export { decodeRpcLine, DESKTOP_RPC_MAX_LINE_BYTES, DESKTOP_RPC_SCHEMA_VERSION } from "./protocol.js";
export type { RpcCommandKind, RpcHello, RpcInbound, RpcOutbound, RpcRequest } from "./protocol.js";
