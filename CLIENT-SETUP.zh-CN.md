# 客户端配置说明

这份说明用于把本项目交给另一台电脑运行。请先补齐下面的连接信息，再将本文件发给使用者。

## 一、填写连接信息

“客户端”指运行本项目、打开控制页面的电脑；“服务器”指已经运行 Minecraft 和 RCON 的 VPS。两类地址不要混填。

| 配置项 | 填写值 | 说明 |
| --- | --- | --- |
| Minecraft 服务器 IP 或域名 |  | 对应 `MC_HOST`，不带 `http://`，不带端口 |
| Minecraft 游戏端口 |  | 对应 `MC_PORT`，用于机器人加入游戏 |
| RCON 服务器 IP 或域名 |  | 对应 `RCON_HOST`，同一台 VPS 时填写与 `MC_HOST` 相同的地址 |
| RCON 控制台端口 |  | 对应 `RCON_PORT`，独立于游戏端口 |
| RCON password |  | 对应 `RCON_PASSWORD`，使用服务器配置的 RCON 密码 |
| 客户端页面监听 IP |  | 对应 `BIND`，本机使用填写 `127.0.0.1` |
| 客户端页面端口 |  | 对应 `PORT`，通常填写 `3010` |
| TypeSafe API Key |  | 对应 `TYPESAFE_API_KEY`；运行 AI 任务时需要，也可以在页面输入 |

游戏端口常见为 `25565`，RCON 端口常见为 `25575`，实际以提供方填写的信息为准。这里的 RCON 面板按本机访问设计，客户端监听 IP 使用 `127.0.0.1` 即可。

## 二、在项目根目录创建 `.env`

把下面内容复制到项目根目录的 `.env` 文件，按上表补齐空白。文件名为 `.env`，不要保存成 `.env.txt`。如果已有 `.env`，更新其中对应项目即可。

```dotenv
# Minecraft 游戏服务器
MC_HOST=
MC_PORT=
MC_VERSION=1.21.4

# RCON 开发者控制台
RCON_HOST=
RCON_PORT=
RCON_PASSWORD=

# 本机控制页面
BIND=
PORT=

# TypeSafe 模型
TYPESAFE_API_KEY=
TYPESAFE_MODEL=jev-latest

# 启动后手动点击 Connect 加入游戏
MC_AUTOCONNECT=0
CONTROL_MODE=highlevel
```

填写时注意：

- 端口只写数字，主机地址中不附加端口。
- 密码如果含有 `#` 或空格，请用一对引号包住实际值，避免被 `.env` 解析为注释或多余空白。
- `TYPESAFE_API_KEY` 可以暂时留空；只使用 RCON 不需要此 Key。
- 表格和模板本身不生效，最终配置以客户端项目根目录中的 `.env` 为准。修改 `.env` 后重启项目。

## 三、安装与启动

客户端需要 Node.js 22 或更高版本。在项目根目录打开终端，首次运行先安装依赖：

```powershell
npm ci
```

Windows 启动命令：

```powershell
powershell -NoProfile -File scripts/start-demo.ps1
```

也可以直接通过 Node 加载配置启动：

```sh
node --env-file=.env src/server.cjs
```

上述两种方式都会读取 `.env`；直接执行 `npm start` 不会自动读取该文件。

浏览器打开 `http://客户端页面监听IP:客户端页面端口`。例如填写的是本机地址和 `3010`，则打开：

```text
http://127.0.0.1:3010
```

两台不同电脑可以使用相同的本机页面端口，它们分别监听自己的地址。

## 四、连接与使用

1. 在页面的 **Minecraft Java backend** 确认服务器地址和游戏端口，点击 **Connect**。因为模板使用 `MC_AUTOCONNECT=0`，启动页面不会自动登录游戏。
2. 页面会显示“本机机器人”名字。main 版本按本机 MAC 摘要生成 `TypeSafeBot` 加 5 位标识，不需要手动设置 bot 名。
3. 点击 **开发者控制台 · RCON**，确认 RCON 地址和端口，点击 **连接**。若 `.env` 已填写密码，面板的密码框可留空；否则在面板输入。
4. 点击 **在线玩家** 检查 RCON 返回；机器人已经加入游戏后，可以查询其坐标和背包。
5. 要启动 Lumber Run 等 AI 任务，填写 TypeSafe API Key，保存后点击 **Start task**。

自定义 RCON 命令需要先暂停机器人任务；内置快捷查询可在任务运行期间使用。完整命令参考见 [RCON 控制台参考手册](docs/rcon-console-reference.zh-CN.md)。

## 五、多电脑使用说明

- 两台电脑都需要使用带自动别名功能的 main 版本，各自安装依赖、填写 `.env` 并启动。
- 不要复制 `node_modules`；在目标电脑运行 `npm ci`。目标电脑会自行创建 `runtime` 中的身份缓存和运行日志。
- 原始 MAC 不会发送到 Minecraft。名字通过短摘要生成；不同 MAC 通常产生不同名字，但受 16 字符上限限制，不能提供绝对不重名保证。
- 同一电脑运行多个实例会使用相同名字，不能靠多开实例获得多个独立玩家。复制了相同 MAC 的虚拟机也可能重名。
- 如果服务器启用了白名单，把各台电脑页面显示的机器人名字分别加入白名单。
- 每个新名字对应独立的 Minecraft 离线玩家，原机器人的背包、位置不会自动继承。

## 六、快速排查

| 现象 | 检查项 |
| --- | --- |
| 控制页面打不开 | 项目进程是否启动；访问地址和 `BIND`、`PORT` 是否一致 |
| Minecraft 连不上 | 是否把 RCON 端口误填为游戏端口；服务器版本与登录方式是否匹配 |
| RCON 提示认证失败 | `RCON_PASSWORD` 是否与服务器密码一致 |
| RCON 密码框为空 | 如果提示后端已保存密码，这是正常状态，可直接连接 |
| 查不到机器人坐标 | 机器人是否已通过 Minecraft backend 加入游戏 |
| Start task 不可用 | 游戏是否连接、API Key 是否保存、机器人是否处于生存模式 |
| 命令超时 | 查看服务器实际状态，面板不会自动重复发送命令 |

需要进一步排查时，查看项目内的 `runtime/trace-*.jsonl` 和 [项目 README](README.md)。
