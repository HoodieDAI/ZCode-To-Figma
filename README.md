# ZCode to Figma

ZCode 插件:让 ZCode 通过自然语言直接读取、创建和编辑 Figma 设计。移植自 [Duoasa/DSH-to-Figma](https://github.com/Duoasa/DSH-to-Figma) 0.3.5(MIT 协议),将 DSH 插件壳替换为 ZCode MCP 服务器,其余核心(本地桥接、Figma 配套插件、工作流 Skill)保持上游实现。

## 组成

- **MCP server**(`server.mjs`,stdio):注册 5 个连接管理工具 + 19 个画布工具(本地模式),可选 official desktop/remote 模式动态注册
- **Figma 配套插件**(`companion/`):由 `figma_setup` 生成"已配对"副本(含本机凭证),在 Figma 桌面端导入运行,通过 `localhost:3055` HTTP 长轮询与桥接通信
- **Skill**(`skills/figma-workbench/`):17 篇离线工作流/帮助文档,配合 `figma_read_guide` 使用
- **CLI**(`cli.mjs`):`node cli.mjs setup|pair|status|login|logout`

## 配置(环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZCODE_FIGMA_BACKEND` | `local` | `local` / `desktop` / `remote` |
| `ZCODE_FIGMA_BRIDGE_PORT` | `3056` | 本地桥接端口;插件 `.mcp.json` 已默认 3056,与 DSH-to-Figma(3055)共存 |
| `ZCODE_FIGMA_TOOL_CALL_TIMEOUT_MS` | `120000` | 画布调用超时 |
| `ZCODE_FIGMA_DESKTOP_SERVER_URL` | `http://127.0.0.1:3845/mcp` | desktop 模式地址 |
| `ZCODE_FIGMA_OAUTH_CLIENT_ID` | — | remote 模式 OAuth client |
| `ZCODE_FIGMA_HOME` | `~/.zcode` | 桥接 token 与已配对 companion 的存放根(`figma/` 子目录) |
| `ZCODE_FIGMA_WORKSPACE` | ZCode 项目目录 | 资产上传/下载的根目录 |
| `ZCODE_FIGMA_DISABLED` | — | 设为 `1` 时 server 直接退出 |

## 快速开始

1. 安装插件后,在 ZCode 里说"帮我连接 Figma"或直接调用 `figma_setup`,按返回路径在 Figma 桌面端 **Plugins → Development → Import plugin from manifest…** 导入一次
2. 在目标文件运行 **ZCode to Figma · Local**,保持插件窗口打开
3. 之后直接用自然语言操作画布;单文件自动连接,多文件用 `figma_select_document`

与上游的语义差异见 `skills/figma-workbench/SKILL.md` 的 "ZCode integration notes":单进程全局文档绑定(所有会话共享)、工作区取 server 启动目录、`create_session` UUID 不跨进程重启。

## 从源码安装

```bash
git clone https://github.com/HoodieDAI/ZCode-To-Figma.git zcode-to-figma
cd zcode-to-figma && npm install --ignore-scripts
node scripts/smoke-mcp.mjs   # 可选:验证 MCP 服务器可用
```

把克隆目录放进(或指到)`<workspace>/plugins/` 下,再按上面的市场流程添加安装即可。

## 仓库结构

```
server.mjs               MCP stdio 服务器(移植层:工具注册/文档绑定/多后端)
cli.mjs                  独立 CLI:setup / pair / status / login / logout
lib/                     桥接、工具目录、脚本预检、资产、OAuth(上游原样)
companion/               Figma 桌面端配套插件(上游原样,品牌替换)
skills/figma-workbench/  工作流 Skill 与 17 篇离线帮助文档
test/                    上游测试套件(85 项)+ scripts/smoke-mcp.mjs 冒烟
```

## 测试

```bash
npm install --ignore-scripts
node --test test/*.test.mjs   # 85 项,覆盖桥接/资产/companion/运行时/预检
node scripts/smoke-mcp.mjs    # 需要 node ≥22;无需 Figma,验证 MCP 握手与 24 个工具
```

## 移植说明(Credits)

- 上游:[Duoasa/DSH-to-Figma](https://github.com/Duoasa/DSH-to-Figma) 0.3.5 —— 桥接协议、Figma companion 插件、工具目录与工作流文档均出自上游,感谢原作者
- 本仓库改动:DSH 插件壳(`index.mjs`,cordis 插件 API)重写为 ZCode MCP stdio 服务器;DSH 会话绑定模型改为单进程全局绑定;`~/.dsh` → `~/.zcode`;品牌与文档适配;默认桥接端口 3056(与 DSH-to-Figma 共存)
- 功能性标识保留:`dsh.*` 脚本运行时 API、`dsh-code-links` 插件数据键,保证与上游脚本与生态兼容

## 许可

MIT(继承上游,见 `LICENSE`;`assets/companion/FEATHER-LICENSE` 为 Feather Icons 许可)。
