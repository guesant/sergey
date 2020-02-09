#!/usr/bin/env node
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { performance } = require('perf_hooks');
const marked = require('marked');
require('dotenv').config();

/**
 * Environment varibales
 */
const getEnv = (argKey, envKey) => {
  return (
    process.env[envKey] ||
    (process.argv.find(x => x.startsWith(argKey)) || '').replace(argKey, '')
  );
};
const isWatching = process.argv.includes('--watch');

const ROOT = getEnv('--root=', 'SERGEY_ROOT') || './';
const PORT = Number(getEnv('--port=', 'SERGEY_PORT')) || 8080;

const IMPORTS_LOCAL = getEnv('--imports=', 'SERGEY_IMPORTS') || '_imports';
const IMPORTS = `${ROOT}${IMPORTS_LOCAL}/`;

const CONTENT_LOCAL = getEnv('--content=', 'SERGEY_CONTENT') || '_imports';
const CONTENT = `${ROOT}${CONTENT_LOCAL}/`;

const OUTPUT_LOCAL = getEnv('--output=', 'SERGEY_OUTPUT') || 'public';
const OUTPUT = `${ROOT}${OUTPUT_LOCAL}/`;

const ACTIVE_CLASS =
  getEnv('--active-class=', 'SERGEY_ACTIVE_CLASS') || 'active';

const EXCLUDE = (getEnv('--exclude=', 'SERGEY_EXCLUDE') || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const VERBOSE = false;
const cachedImports = {};

const excludedFolders = [
  '.git',
  '.DS_Store',
  '.prettierrc',
  'node_modules',
  'package.json',
  'package-lock.json',
  IMPORTS_LOCAL,
  OUTPUT_LOCAL,
  ...EXCLUDE
];

const patterns = {
  whitespace: /^\s+|\s+$/g
};

/**
 * FS utils
 */
const copyFile = (src, dest) => {
  return new Promise((resolve, reject) => {
    fs.copyFile(src, dest, err => {
      if (err) {
        return reject(err);
      } else {
        VERBOSE && console.log(`Copied ${src}`);
        resolve();
      }
    });
  });
};

const createFolder = path => {
  return new Promise((resolve, reject) => {
    fs.readdir(path, (err, data) => {
      if (err) {
        fs.mkdir(path, (err, data) => {
          return err ? reject(`Couldn't create folder: ${path}`) : resolve();
        });
      } else {
        return resolve();
      }
    });
  });
};

const readDir = path => {
  return new Promise((resolve, reject) => {
    fs.readdir(path, (err, data) => (err ? reject(err) : resolve(data)));
  });
};

const readFile = path => {
  return new Promise((resolve, reject) => {
    fs.readFile(path, (err, data) =>
      err ? reject(err) : resolve(data.toString())
    );
  });
};

const writeFile = (path, body) => {
  return new Promise((resolve, reject) => {
    fs.writeFile(path, body, err => {
      if (err) {
        return reject(err);
      }

      VERBOSE && console.log(`Saved ${path}`);
      return resolve();
    });
  });
};

const clearOutputFolder = async () => {
  const deleteFolder = path => {
    if (fs.existsSync(path)) {
      fs.readdirSync(path).forEach(function(file, index) {
        const newPath = path + '/' + file;
        if (fs.lstatSync(newPath).isDirectory()) {
          deleteFolder(newPath);
        } else {
          fs.unlinkSync(newPath);
        }
      });
      fs.rmdirSync(path);
    }
  };

  return deleteFolder(OUTPUT);
};

const getAllFiles = (path, filter, exclude = false) => {
  path = path.endsWith('/') ? path.substring(0, path.length - 1) : path;

  const files = [];
  const filesToIgnore = [...excludedFolders];
  if (!filter) {
    filter = () => true;
  }

  if (exclude) {
    const importIndex = filesToIgnore.indexOf(IMPORTS_LOCAL);
    if (importIndex !== -1) filesToIgnore.splice(importIndex, 1);

    const contentIndex = filesToIgnore.indexOf(CONTENT_LOCAL);
    if (contentIndex !== -1) filesToIgnore.splice(contentIndex, 1);
  }

  if (fs.existsSync(path)) {
    fs.readdirSync(path).forEach((file, index) => {
      if (filesToIgnore.find(x => file.startsWith(x))) {
        return;
      }

      const newPath = path + '/' + file;
      if (fs.lstatSync(newPath).isDirectory()) {
        files.push(...getAllFiles(newPath, filter, exclude));
      } else {
        if (!filter(file)) {
          return;
        }

        files.push(newPath);
      }
    });
  }

  return files;
};

const getFilesToWatch = path => {
  return getAllFiles(path, '', true);
};

/**
 * Helpers
 */
const getDom = content => new JSDOM(content);

// https://html.spec.whatwg.org/multipage/syntax.html#void-elements
const VOID_ELEMENTS = [
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
];


// `<sergey-slot ...args />` -> `<sergey-slot ...args></sergey-slot>`
// the function ignores void elements like `<img />`
const prepareHTML = html => {
  let newHtml = html;

  (newHtml.match(/<[^<|\/>]+\/>/g) || [])
    .map(original => {
      const def = original.slice(1, -2).trim();
      const tagName = def.split(' ')[0].trim();

      return { original, def, tagName };
    })
    .filter(({ tagName }) => !VOID_ELEMENTS.includes(tagName))
    .forEach(({ original, def, tagName }) => {
      let newTagContent = def;
      newTagContent = `<${newTagContent}></${tagName}>`;
      newHtml = newHtml.replace(original, newTagContent);
    });

  return newHtml;
};

const formatContent = x => x.replace(patterns.whitespace, '');
const getKey = (key, ext = '.html', folder = '') => {
  const file = key.endsWith(ext) ? key : `${key}${ext}`;
  return `${folder}${file}`;
};
const hasImports = x => x.includes('<sergey-import');
const hasLinks = x => x.includes('<sergey-link');
const primeExcludedFiles = name => {
  if (!excludedFolders.includes(name)) {
    excludedFolders.push(name);
  }
};
const cleanPath = path => path.replace('index.html', '').split('#')[0];
const isCurrentPage = (ref, path) => path && cleanPath(path) === cleanPath(ref);
const isParentPage = (ref, path) =>
  path && cleanPath(path).startsWith(cleanPath(ref));

/**
 * #business logic
 */
const prepareImports = async folder => {
  const fileNames = await getAllFiles(folder);
  const bodies = await Promise.all(fileNames.map(readFile));
  fileNames.forEach((path, i) => primeImport(path, bodies[i]));
};

const primeImport = (path, body) => {
  cachedImports[path] = body;
};

const tagChange = ({ body: argBody, selector }, fn) => {
  let body = argBody;

  const changeItem = i => fn(i);
  const changeItemsByHTML = html => {
    const dom = getDom(html || body);
    const items = dom.window.document.querySelectorAll(selector);

    items.forEach(i => {
      const find = i.outerHTML;
      body = body.replace(find, changeItem(i, find));
    });
  };
  changeItemsByHTML();

  // bug-fix for tags inside tags
  // <meta foo="<sergey-slot></sergey-slot>">
  if (body.includes(`</${selector}>`)) {
    const regexpRangeTag = selector.replace('-', '\\-');

    const remaingTags =
      body.match(
        new RegExp(
          `<${selector}[^<]*>[^<${regexpRangeTag}]*<\\/sergey-slot>`,
          'g'
        )
      ) || [];

    changeItemsByHTML(remaingTags.join(''));
  }

  return body;
};

const getSlots = content => {
  // Extract templates first
  const slots = {
    default: formatContent(content) || ''
  };

  const dom = getDom(content);
  const items = dom.window.document.querySelectorAll('sergey-template');

  // Search content for templates
  items.forEach(i => {
    const find = i.outerHTML;
    const name = i.getAttribute('name') || '';
    const data = i.innerHTML;

    if (name !== 'default') {
      // Remove it from the default content
      slots.default = slots.default.replace(find, '');
    }

    // Add it as a named slot
    slots[name] = formatContent(data);
  });

  slots.default = formatContent(slots.default);

  return slots;
};

const compileSlots = (argBody, slots) => {
  let body = argBody;

  body = tagChange({ body, selector: 'sergey-slot' }, i => {
    const name = i.getAttribute('name') || 'default';
    const fallback = i.innerHTML;

    return slots[name] || fallback || '';
  });

  return body;
};

const compileImport = (argBody, pattern) => {
  let body = argBody;

  body = tagChange({ body, selector: pattern }, i => {
    let replace = '';

    let key = i.getAttribute('src');
    let htmlAs = i.getAttribute('as') || '';
    let content = i.innerHTML || '';

    if (htmlAs === 'markdown') {
      replace = formatContent(
        marked(cachedImports[getKey(key, '.md', CONTENT)] || '')
      );
    } else {
      replace = cachedImports[getKey(key, '.html', IMPORTS)] || '';
    }

    const slots = getSlots(content);

    // Recurse
    replace = compileTemplate(replace, slots);
    return replace;
  });

  return body;
};

const compileTemplate = (fileContent, slots = { default: '' }) => {
  let body = prepareHTML(fileContent);
  body = compileSlots(body, slots);

  if (!hasImports(body)) {
    return body;
  }

  body = compileImport(body, 'sergey-import');

  return body;
};

const compileLinks = (argBody, path) => {
  let body = argBody;

  if (!hasLinks(body)) {
    return body;
  }

  body = tagChange({ body, selector: 'sergey-link' }, i => {
    const toAttr = ['to', 'href'].find(k => i.hasAttribute(k));
    const to = i.getAttribute(toAttr) || '';
    i.removeAttribute(toAttr);

    const isCurrent = isCurrentPage(to, path);
    if (isCurrent || isParentPage(to, path)) {
      const currClass = i.getAttribute('class') || '';
      i.setAttribute('class', `${ACTIVE_CLASS} ${currClass.trimLeft()}`.trim());

      if (isCurrent) {
        i.setAttribute('aria-current', 'page');
      }
    }

    return i.outerHTML
      .replace(/^<sergey-link/, '<a')
      .replace('</sergey-link>', '</a>')
      .replace(/^<a/, `<a href="${to}"`);
  });

  return body;
};

const compileFolder = async (localFolder, localPublicFolder) => {
  const fullFolderPath = `${ROOT}${localFolder}`;
  const fullPublicPath = `${ROOT}${localPublicFolder}`;

  if (localPublicFolder) {
    await createFolder(fullPublicPath);
  }

  return new Promise((resolve, reject) => {
    fs.readdir(fullFolderPath, async (err, files) => {
      if (err) {
        return reject(`Folder: ${fullFolderPath} doesn't exist`);
      }

      Promise.all(
        files
          .filter(x => {
            return !excludedFolders.find(y => x.startsWith(y));
          })
          .map(async localFilePath => {
            const fullFilePath = `${fullFolderPath}${localFilePath}`;
            const fullPublicFilePath = `${fullPublicPath}${localFilePath}`;
            const fullLocalFilePath = `/${localFolder}${localFilePath}`;

            if (localFilePath.endsWith('.html')) {
              return readFile(fullFilePath)
                .then(compileTemplate)
                .then(body => compileLinks(body, fullLocalFilePath))
                .then(body => writeFile(fullPublicFilePath, body));
            }

            return new Promise((resolve, reject) => {
              fs.stat(fullFilePath, async (err, stat) => {
                if (err) {
                  return reject(err);
                }

                if (stat && stat.isDirectory()) {
                  await compileFolder(
                    `${localFolder}${localFilePath}/`,
                    `${OUTPUT_LOCAL}/${localFolder}${localFilePath}/`
                  );
                } else {
                  await copyFile(fullFilePath, fullPublicFilePath);
                }
                return resolve();
              });
            });
          })
      )
        .then(resolve)
        .catch(reject);
    });
  });
};

const compileFiles = async () => {
  try {
    await readDir(IMPORTS);
  } catch (e) {
    console.error(`No ${IMPORTS} folder found`);
    return;
  }

  try {
    const start = performance.now();

    await clearOutputFolder();
    await prepareImports(IMPORTS);

    if (IMPORTS !== CONTENT) {
      try {
        await readDir(CONTENT);
        await prepareImports(CONTENT);
      } catch (e) {}
    }

    await compileFolder('', `${OUTPUT_LOCAL}/`);

    const end = performance.now();

    console.log(`Compiled in ${Math.ceil(end - start)}ms`);
  } catch (e) {
    console.log(e);
  }
};

const excludeGitIgnoreContents = async () => {
  try {
    const ignore = await readFile('./.gitignore');
    const exclusions = ignore
      .split('\n')
      .map(x => (x.endsWith('/') ? x.substring(0, x.length - 1) : x))
      .map(x => (x.startsWith('/') ? x.substring(1, x.length) : x))
      .filter(Boolean)
      .map(primeExcludedFiles);
  } catch (e) {}
};

const sergeyRuntime = async () => {
  if (!OUTPUT.startsWith('./')) {
    console.error('DANGER! Make sure you start the root with a ./');
    return;
  }

  if (!ROOT.endsWith('/')) {
    console.error('Make sure you end the root with a /');
    return;
  }

  await excludeGitIgnoreContents();
  await compileFiles();

  if (isWatching) {
    const chokidar = require('chokidar');
    const connect = require('connect');
    const serveStatic = require('serve-static');

    const watchRoot = ROOT.endsWith('/')
      ? ROOT.substring(0, ROOT.length - 1)
      : ROOT;
    let ignored = (OUTPUT.endsWith('/')
      ? OUTPUT.substring(0, OUTPUT.length - 1)
      : OUTPUT
    ).replace('./', '');

    const task = async () => await compileFiles();

    const watcher = chokidar.watch(watchRoot, { ignored, ignoreInitial: true });
    watcher.on('change', task);
    watcher.on('add', task);
    watcher.on('unlink', task);

    connect()
      .use(serveStatic(OUTPUT))
      .listen(PORT, function() {
        console.log(`Sergey running on http://localhost:${PORT}`);
      });
  }
};

module.exports = {
  sergeyRuntime,
  compileTemplate,
  compileLinks,
  primeImport,
  CONTENT,
  IMPORTS,
  ACTIVE_CLASS
};
