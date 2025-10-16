# ====== 用户可改部分 ======
TOKEN=undeGitlab-nxfMzCsmbnsGGxGcDPkY          # 刚才复制的令牌
CI_SERVER_URL=https://gitlab.unde.site          # 自建实例就换域名
CI_PROJECT_ID=38                    # 项目首页右下角显示的数字 ID
PACKAGE_NAME=vscode-fast-cpp              # 自定义包名
PACKAGE_VERSION=0.1.0                     # 版本号（semver）
VSIX_FILE=vscode-fast-cpp-0.1.0.vsix               # 本地产物路径
# ===========================

curl --header "PRIVATE-TOKEN: ${TOKEN}" \
     --upload-file "${VSIX_FILE}" \
     "${CI_SERVER_URL}/api/v4/projects/${CI_PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${PACKAGE_VERSION}/${VSIX_FILE}"
     