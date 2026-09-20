// 兼容入口：预览/启动脚本可能在工作区根目录执行 `node serve.mjs`。
// 真正的服务器在 site/serve.mjs——它的静态根目录由自身 import.meta.url 决定，
// 从这里转发启动参数（--host/--port）即可，行为与直接启动它完全一致。
import './site/serve.mjs';
