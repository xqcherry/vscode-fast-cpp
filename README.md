# fast-cpp-runner

## 安装 Nodejs 环境
可选择以下两种方法之一
1. [nodejs官方链接](https://nodejs.org/en)
2. NVM安装
   ```
   nvm install node
   ```

## 创建 VScode 插件
可任以下一种方式使用脚手架工具
1. 无需安装到本地，直接创建项目
   ```
   npx --package yo --package generator-code -- yo code
   ```
2. 安装脚手架工具到本地并使用
   ```
   npm install --global yo generator-code   // 工具安装
   yo code  // 创建插件项目
   ```
## 插件打包 - VSCE
安装
```
npm install -g @vscode/vsce
npm install -g vsce
```
打包和发布
1. 打包成 VSIX, 在项目根目录下执行
```
vsce package
```
> vsce 打包时如果项目的依赖是采用了 pnpm 进行下载的，需要删除 node_modules 然后使用 npm 重新下载，再执行 vsce package
2. 发布
```
vsce publish
```
> 发布前请检查`package.json`中是否已经配置好了`publisher`