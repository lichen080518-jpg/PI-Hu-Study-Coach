# 沪学伴

面向一名上海初中生的局域网辅导应用。手机和电脑使用同一套网页，支持语文、数学、英语试卷批改复核、错题本、按题辅导、独立短测和 PDF 复练卷。

- `client/` 是浏览器界面，服务端同源提供静态文件。
- `server/` 是独立的 Node.js 服务，使用 Pi Agent Core、Fastify 和 SQLite。依赖版本由 `server/package-lock.json` 固定。

## 本机启动

使用 Node.js 22.19 或更新版本。在仓库根目录执行以下 PowerShell 命令。

```powershell
Set-Location apps/hu-study-coach/server
npm ci --ignore-scripts
Copy-Item .env.example .env
```

在 `.env` 中填写两个不同的强口令 `TUTOR_REVIEWER_PASSCODE` 和 `TUTOR_STUDENT_PASSCODE`，长度至少 12 个字符。运行 `npm start` 后访问 `http://127.0.0.1:8787`。学生和复核人均可上传试卷、查看自动批改结果和完成练习。复核人可改判已识别的题目。

### 接入 Pi 模型

复核人可在「模型设置」中选择 OpenAI Codex 或本机模型。使用 Codex 时可选择支持图片的模型及其推理级别，并在「授权 OpenAI Codex」完成 ChatGPT 登录。配置即时应用于后续批改、辅导和出题。选择 Codex 后，批改页图和相关参考资料会发送给 OpenAI，复练出题会发送所选错题的题干和错因。账号授权仅保存在主机。

可用 `TUTOR_MODEL_PROVIDER=openai-codex` 和 `TUTOR_CODEX_MODEL=gpt-6.1-sol` 设置首次启动的默认模型，并用 `TUTOR_CODEX_REASONING_LEVEL` 设置初始推理级别。Codex 授权优先使用本机 Pi 的 `auth.json`，也可用 `TUTOR_CODEX_AUTH_FILE` 指定授权文件。若主机尚无 Pi 授权文件，沪学伴将凭据保存在数据目录。

使用本机模型时，将实际模型 ID 填入 `.env` 的 `TUTOR_MODEL`，并用 `TUTOR_MODEL_BASE_URL` 配置 `/v1` API 地址。默认地址是 `http://127.0.0.1:11434/v1`。视觉模型还需设置 `TUTOR_MODEL_VISION=1`。支持 `json_schema` 响应格式的服务可设置 `TUTOR_MODEL_STRUCTURED_GRADING=1`，约束批改输出。配好后重启服务。上传时可附参考答案，例如 `第1题：x=3`。

原卷图像和 PDF 在主机转换，自动识别支持一次最多 12 个展开页。上传后自动标记正确、错误或待确认。判错题直接进入错题本，图片上有明确分值时才展示分值。复核人可从作业详情选择「重新批改」，系统直接使用已保存的原卷。重批完成后，详情页标示判定和分值等变化、新识别的题，以及本轮未匹配而沿用上一版判定的题。

如通过自定义 HTTPS 兼容接口辅助纯文本对话，需设置 `TUTOR_ALLOW_CLOUD=1` 并填写该接口的 API 密钥。试卷图片使用已配置的本机视觉模型或已授权的 OpenAI Codex。需要断网运行时，使用本地模型。

PDF 由主机的 Chromium、Chrome 或 Edge 生成。可用 `TUTOR_CHROMIUM_PATH` 指定浏览器可执行文件。主机需要安装中文字形覆盖完整的字体，例如微软雅黑或 Noto Sans CJK SC。

### 局域网访问

1. 给常开主机保留固定内网 IP，配置本地 DNS，将 `tutor.home.arpa` 指向该 IP。
2. 将 `TUTOR_PUBLIC_ORIGIN` 设为 `https://tutor.home.arpa`，重启辅导服务。若调整 `TUTOR_PORT`，同步修改代理目标端口。
3. 在主机上执行 `caddy run --config Caddyfile.example --adapter caddyfile`。同一 Wi-Fi 的设备需信任 Caddy 的本地 CA。仅在主机防火墙开放局域网 HTTPS 入口。服务自身监听 `127.0.0.1`。
4. 手机和电脑打开同一个 HTTPS 地址。第一次连接应验证手机能拍照上传、两端能看到同一份批改结果并打开 PDF。

[Caddy 本地 HTTPS 配置](https://caddyserver.com/docs/automatic-https#local-https)

## 试卷、复练与统计口径

- 照片支持 JPEG、PNG、WebP，也可上传 PDF。每份文件上限 12 MiB，单次至多 12 份文件、合计 48 MiB。
- 「错题复练」根据已确认错题的题干和错因生成变式。自动选题每卷最多 6 题，优先安排到期和近期尚未练到的题目。自主勾选可按科目选择最多 40 条错题，每条生成一道变式。默认每周日上海时间 19:00 生成到期复练卷，重启后检查最近一个排期。
- 批改时会记录可定位错题的原卷区域，错题本从原卷显示截图。复核人可在错题卡片预览原页、补存截图或调整裁剪范围。
- 复核人可在「改判」选择忽略。已忽略的题保留原判定和分值。错题本与复练选题会跳过这类题，改回「错误」可恢复收录。
- 「独立短测」按各科固定考点、难度和分值生成新题。进退曲线只使用完整、已评分且声明独立完成的首次作答。学校卷得分另行显示，有未判分项的短测等复核完成后进入统计。学生可使用纸卷练习和上传复核，独立趋势使用网页短测记录。
- 两种练习都由当前模型出题并另行核验，通过后可导出 A4 学生卷。答案 PDF 单独授权，学生提交网页作答或纸卷完成批改后可查看。
- 复核人可删除练习卷和作业。删除练习卷会移除该卷的在线作答，并将关联的纸卷转为独立作业。删除作业会移除该作业的批改历史、附件和错题。学习统计随删除重新计算。

数据库和附件默认位于 `server/data/`。备份时先停止服务，再将整个目录复制到独立位置。恢复时在另一数据目录启动服务并打开已上传的试卷和复练卷，确认数据和附件可读。

## 验证

在 `server/` 执行 `npm run check` 和 `npm run test:integration`。集成测试使用临时数据库、模拟模型和本机 Chromium，验证权限、上传去重、无分值批改、自动错题收录、改判、按题流式回复、PDF 和短测统计。真实模型的手写识别效果需用脱敏试卷单独验收。
