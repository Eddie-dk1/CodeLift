import fs from "node:fs";
import path from "node:path";
import ts from "typescript-compat";
import { AnalysisError } from "./errors.js";

export interface LoadedCompilerProject {
  program: ts.Program;
  compilerOptions: ts.CompilerOptions;
  configPath: string;
  typescriptVersion: string;
  rootNames: string[];
}

export interface ModuleResolution {
  resolvedFileName?: string;
  isExternalLibraryImport: boolean;
}

export interface CompilerAdapter {
  loadProject(configPath: string, entrypoint: string): LoadedCompilerProject;
  getSourceFile(project: LoadedCompilerProject, absolutePath: string): ts.SourceFile | undefined;
  resolveModule(
    project: LoadedCompilerProject,
    specifier: string,
    containingFile: string,
  ): ModuleResolution;
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

export class TypeScriptCompilerAdapter implements CompilerAdapter {
  loadProject(configPath: string, entrypoint: string): LoadedCompilerProject {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      throw new AnalysisError("TSCONFIG_READ_FAILED", formatDiagnostic(configFile.error));
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );

    const configurationErrors = parsed.errors.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (configurationErrors.length > 0) {
      throw new AnalysisError(
        "TSCONFIG_INVALID",
        configurationErrors.map(formatDiagnostic).join("\n"),
      );
    }

    const rootNames = [...new Set([...parsed.fileNames, entrypoint])];
    const program = ts.createProgram({
      rootNames,
      options: parsed.options,
      ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
    });

    return {
      program,
      compilerOptions: parsed.options,
      configPath,
      typescriptVersion: ts.version,
      rootNames,
    };
  }

  getSourceFile(project: LoadedCompilerProject, absolutePath: string): ts.SourceFile | undefined {
    const direct = project.program.getSourceFile(absolutePath);
    if (direct) return direct;

    const normalized = path.resolve(absolutePath);
    return project.program
      .getSourceFiles()
      .find((sourceFile) => path.resolve(sourceFile.fileName) === normalized);
  }

  resolveModule(
    project: LoadedCompilerProject,
    specifier: string,
    containingFile: string,
  ): ModuleResolution {
    const host: ts.ModuleResolutionHost = {
      fileExists: fs.existsSync,
      readFile: (fileName) => {
        try {
          return fs.readFileSync(fileName, "utf8");
        } catch {
          return undefined;
        }
      },
      directoryExists: (directoryName) => {
        try {
          return fs.statSync(directoryName).isDirectory();
        } catch {
          return false;
        }
      },
      getCurrentDirectory: () => path.dirname(project.configPath),
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      ...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
    };

    const resolution = ts.resolveModuleName(
      specifier,
      containingFile,
      project.compilerOptions,
      host,
    ).resolvedModule;

    if (!resolution) return { isExternalLibraryImport: false };

    return {
      resolvedFileName: resolution.resolvedFileName,
      isExternalLibraryImport: resolution.isExternalLibraryImport ?? false,
    };
  }
}
