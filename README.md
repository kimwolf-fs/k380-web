# K380 Web

K380 键盘静态配置工具：Web Serial 改键、预设、中文宏源码编辑、浏览器编译、设备测试与执行日志、源码 JSON 导入导出。

无需 npm 或 Python 后台。桌面 Chrome/Edge 打开 HTTPS 站点，选择 K380 并按需使用 Fn+Backspace 解锁。源码保存在当前浏览器站点存储，完整备份请导出 JSON。键盘只保存 VM 字节码。导入只修改草稿，保存宏才写入设备。

## 开发与验证

- Node 22+：`node --test *.test.mjs`（受限 Windows 环境可增加 `--test-isolation=none`）。
- 本地静态服务：`python -m http.server 8775 --bind 127.0.0.1`。
- 发布目录：`node scripts/stage.mjs`，输出 `_site/`，仅包含运行文件及 CodeMirror 依赖。
- Pages 工作流先测试后部署。用户宏和备份不会上传到本仓库。

## 第一版限制

16 宏/预设、4 预设、2 层；code 1024 字节、包 1104 字节；函数 16、调用深度 8、循环深度 3；一次运行一个宏，新触发忽略。不提供旧 v1 宏兼容保证、反编译或 GitHub 源码同步；20 ms 精确停止时延未测量。

从 localhost 转到 Pages 前，请导出源码，再在正式站点导入；两者站点存储不共享。

## 许可

CodeMirror 5.65.21 的 MIT 许可证保留在 vendor/codemirror-5.65.21/LICENSE。项目自有代码暂未另行授予开源许可证；公开可查看不等于授予再分发许可。
