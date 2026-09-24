#!/usr/bin/env node
/**
 * 把 expo prebuild 生成的 android/app/build.gradle 改成「用你自己的 keystore 签 release 包」。
 *
 * 用法（在 lifelog-app 目录下执行）：
 *   RC_STORE_PASSWORD=xxx RC_KEY_ALIAS=xxx RC_KEY_PASSWORD=xxx \
 *   node scripts/apply-release-signing.mjs android/app/build.gradle [android/app/release.jks]
 *
 * 为什么要改这个文件：
 *   RN / Expo 模板里 release 构建类型默认写的是
 *       signingConfig signingConfigs.debug
 *   也就是用模板自带、人人相同的那把公开 debug key 签名。这样打出来的包：部分手机的
 *   安全扫描会拦、Play 保护机制会提示来源不明，而且永远无法覆盖安装用「你自己的 key」
 *   签过的包（签名不一致 → 应用未安装）。这里把它换成 release 签名配置，密码/别名
 *   从环境变量读，避免出现在命令行里被写进构建日志。
 *
 * 环境变量（只在构建机上有值，不进仓库）：
 *   RC_STORE_PASSWORD / RC_KEY_ALIAS / RC_KEY_PASSWORD
 *
 * 幂等：重复执行只会把已有的 release 签名配置覆盖成同一份内容。
 */
import fs from 'node:fs';
import path from 'node:path';

const gradlePath = process.argv[2] || 'android/app/build.gradle';
const keystorePath = process.argv[3] || 'android/app/release.jks';
const keystoreName = path.basename(keystorePath);

/* 从 openIdx 处的 '{' 找到配对的 '}'：跳过行注释、块注释和字符串字面量，
   避免被 "// see https://..." 里的括号或字符串里的括号带偏 */
function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === quote) break;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 找到 `header {` 这一块：返回 { start, open, close }
function findBlock(text, header, from = 0) {
  const re = new RegExp(`(^|[^\\w.])${header}\\s*\\{`, 'g');
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', m.index);
  const close = matchBrace(text, open);
  if (open < 0 || close < 0) return null;
  // start 才是 header 本身的位置（去掉正则吃掉的那个前导字符，保留它自己的缩进）
  return { start: m.index + (m[1] ? m[1].length : 0), open, close };
}

// 某个位置所在行开头的缩进，用来让插入的代码和邻居对齐
const indentAt = (text, index) => {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart, index));
  return m ? m[0] : '';
};

// 如果 index 前面到行首之间只有空白（也就是这个匹配本身占了一整行），就把位置提到行首，
// 这样替换时不会把它自己的缩进叠到新内容前面
const lineStartOf = (text, index) => {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, index)) ? lineStart : index;
};

let src;
try {
  src = fs.readFileSync(gradlePath, 'utf8');
} catch (e) {
  console.error(`[sign] 读不到 ${gradlePath}：${e.message}`);
  process.exit(1);
}

// ---- 1) 在 signingConfigs 里补一份 release 配置 ----
const signing = findBlock(src, 'signingConfigs');
if (!signing) {
  console.error('[sign] 没找到 signingConfigs 块，android/app/build.gradle 的结构和预期不符');
  process.exit(1);
}

// 缩进跟着模板里已有的 debug { ... } 走
const debugCfg = findBlock(src, 'debug', signing.open);
const cfgIndent = debugCfg && debugCfg.close < signing.close ? indentAt(src, debugCfg.start) : '        ';
const cfgBodyIndent = `${cfgIndent}    `;
const releaseSigning = [
  `${cfgIndent}release {`,
  `${cfgBodyIndent}// 由构建脚本注入：keystore 在构建时写到 android/app/ 下，仓库里不留私钥`,
  `${cfgBodyIndent}storeFile file('${keystoreName}')`,
  `${cfgBodyIndent}storePassword System.getenv('RC_STORE_PASSWORD')`,
  `${cfgBodyIndent}keyAlias System.getenv('RC_KEY_ALIAS')`,
  `${cfgBodyIndent}keyPassword System.getenv('RC_KEY_PASSWORD')`,
  `${cfgBodyIndent}enableV1Signing true`,
  `${cfgBodyIndent}enableV2Signing true`,
  `${cfgBodyIndent}enableV3Signing true`,
  `${cfgIndent}}`,
  '',
].join('\n');

let out = src;
const existingRelease = findBlock(src, 'release', signing.open);
if (existingRelease && existingRelease.close < signing.close) {
  const cutFrom = lineStartOf(src, existingRelease.start);
  // 新块自带行尾换行，所以紧跟原块的那个换行要一起吃掉，否则每跑一次多一个空行
  const cutTo = src[existingRelease.close + 1] === '\n' ? existingRelease.close + 2 : existingRelease.close + 1;
  out = src.slice(0, cutFrom) + releaseSigning + src.slice(cutTo);
} else {
  // 插到 signingConfigs 收尾那行的行首（直接插在 '}' 前会把 '}' 那行的缩进顶到我们前面）
  const insertAt = src.lastIndexOf('\n', signing.close) + 1;
  out = src.slice(0, insertAt) + releaseSigning + src.slice(insertAt);
}

// ---- 2) buildTypes 里的 release 改成用刚加的签名配置 ----
const buildTypes = findBlock(out, 'buildTypes');
if (!buildTypes) {
  console.error('[sign] 没找到 buildTypes 块，android/app/build.gradle 的结构和预期不符');
  process.exit(1);
}
const releaseType = findBlock(out, 'release', buildTypes.open);
if (!releaseType || releaseType.close > buildTypes.close) {
  console.error('[sign] 没找到 buildTypes.release 块，android/app/build.gradle 的结构和预期不符');
  process.exit(1);
}

const typeBlock = out.slice(releaseType.open, releaseType.close);
const patchedType = /signingConfig\s+signingConfigs\.[\w]+/.test(typeBlock)
  ? typeBlock.replace(/signingConfig\s+signingConfigs\.[\w]+/, 'signingConfig signingConfigs.release')
  : typeBlock.replace('{', `{\n${indentAt(out, releaseType.start)}    signingConfig signingConfigs.release`);
out = out.slice(0, releaseType.open) + patchedType + out.slice(releaseType.close);

fs.writeFileSync(gradlePath, out);

// ---- 自检：把结果里两处关键内容打出来，构建日志里能一眼看到生效了 ----
const checkRelease = /release\s*\{[\s\S]*?storeFile file\('[^']+'\)/.test(out);
const checkType = /buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?signingConfig signingConfigs\.release/.test(out);
if (!checkRelease || !checkType) {
  console.error('[sign] 改写后自检没通过，请检查 android/app/build.gradle');
  process.exit(1);
}
console.log(`[sign] 已写入 release 签名配置：keystore = ${keystoreName}，release 构建类型 = signingConfigs.release`);
