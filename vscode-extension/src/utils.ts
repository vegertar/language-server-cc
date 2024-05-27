import * as glob from "glob";
import * as fs from "fs";
import * as path from "path";

// Read the files in a directory.
export function readDir(dirPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    fs.readdir(dirPath, (error, list) => {
      if (error) {
        resolve([]);
      } else {
        resolve(list);
      }
    });
  });
}

// Get the fs.lstat using async function.
export function getLStat(filePath: string): Promise<fs.Stats | undefined> {
  return new Promise((resolve) => {
    fs.lstat(filePath, (_err, stats) => {
      if (stats) {
        resolve(stats);
      } else {
        resolve(undefined);
      }
    });
  });
}

/**
 * Escape a string so it can be used as a regular expression
 */
export function escapeStringForRegex(str: string): string {
  return str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
}

/**
 * Replace all occurrences of `needle` in `str` with `what`
 * @param str The input string
 * @param needle The search string
 * @param what The value to insert in place of `needle`
 * @returns The modified string
 */
export function replaceAll(str: string, needle: string, what: string) {
  const pattern = escapeStringForRegex(needle);
  const re = new RegExp(pattern, "g");
  return str.replace(re, what);
}

type NormalizationSetting = "always" | "never" | "platform";
interface PathNormalizationOptions {
  normCase?: NormalizationSetting;
  normUnicode?: NormalizationSetting;
}

/**
 * Completely normalize/canonicalize a path.
 * Using `path.normalize` isn't sufficient. We want convert all paths to use
 * POSIX separators, remove redundant separators, and sometimes normalize the
 * case of the path.
 *
 * @param p The input path
 * @param opt Options to control the normalization
 * @returns The normalized path
 */
export function normalizePath(
  p: string,
  opt: PathNormalizationOptions
): string {
  const normCase: NormalizationSetting = opt
    ? opt.normCase
      ? opt.normCase
      : "never"
    : "never";
  const normUnicode: NormalizationSetting = opt
    ? opt.normUnicode
      ? opt.normUnicode
      : "never"
    : "never";
  let norm = path.normalize(p);
  while (path.sep !== path.posix.sep && norm.includes(path.sep)) {
    norm = norm.replace(path.sep, path.posix.sep);
  }
  // Normalize for case an unicode
  switch (normCase) {
    case "always":
      norm = norm.toLocaleLowerCase();
      break;
    case "platform":
      if (process.platform === "win32" || process.platform === "darwin") {
        norm = norm.toLocaleLowerCase();
      }
      break;
    case "never":
      break;
  }
  switch (normUnicode) {
    case "always":
      norm = norm.normalize();
      break;
    case "platform":
      if (process.platform === "darwin") {
        norm = norm.normalize();
      }
      break;
    case "never":
      break;
  }
  // Remove trailing slashes
  norm = norm.replace(/\/$/g, "");
  // Remove duplicate slashes
  while (norm.includes("//")) {
    norm = replaceAll(norm, "//", "/");
  }
  return norm;
}

export function lightNormalizePath(p: string): string {
  return normalizePath(p, { normCase: "never", normUnicode: "never" });
}

export function getRelativePath(file: string, dir: string): string {
  const relPath: string = lightNormalizePath(path.relative(dir, file));
  const joinedPath = "${workspaceFolder}/".concat(relPath);
  return joinedPath;
}

export async function getAllTUPaths(
  path: string
): Promise<string[] | undefined> {
  const regex: RegExp = new RegExp(/\.o$/);
  return recGetAllFilePaths(path, regex, await readDir(path), []);
}

async function recGetAllFilePaths(
  dir: string,
  regex: RegExp,
  files: string[],
  result: string[]
) {
  for (const item of files) {
    const file = path.join(dir, item);
    try {
      const status = await getLStat(file);
      if (status) {
        if (status.isDirectory() && !status.isSymbolicLink()) {
          result = await recGetAllFilePaths(
            file,
            regex,
            await readDir(file),
            result
          );
        } else if (status.isFile() && regex.test(file)) {
          result.push(file);
        }
      }
    } catch (error) {
      continue;
    }
  }
  return result;
}

export async function globForFileName(
  fileName: string,
  depth: number,
  cwd: string
): Promise<boolean> {
  let starString = "*";
  for (let i = 1; i <= depth; i++) {
    if (await globWrapper(`${starString}/${fileName}`, cwd)) {
      return true;
    }
    starString += "/*";
  }
  return false;
}

function globWrapper(globPattern: string, cwd: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    glob(globPattern, { cwd }, (err, files) => {
      if (err) {
        return reject(false);
      }

      if (files.length > 0) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}
