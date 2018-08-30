"use strict";
const R = require("ramda")
const path = require("path")
const fs = require("fs")
const globby = require("globby")
const minimatch = require("minimatch")
const treey = require("treey")
const stackTrace = require('stack-trace')

function fsReadFileSyncCwd(path_relative_to_cwd) {
  const cwd = process.cwd();
  const full_path = path.isAbsolute(path_relative_to_cwd) ? 
    path_relative_to_cwd : path.join(cwd, path_relative_to_cwd);
  return fs.readFileSync(full_path).toString();
}

function _getCallerFileName() {
  const stack_files = stackTrace.parse(new Error()).map(({
    fileName
  }) => fileName);
  const caller_file = stack_files.find(filepath => 
    filepath && 
    (path.basename(filepath) === ".ggyp" ||
    minimatch(filepath, "*.{ggyp,ggypi}", {matchBase:true }))
  );
  return caller_file;
}

function base2local_path(except_relative_path) {
  const cwd = process.cwd();
  let base = path.dirname(_getCallerFileName());
  let result_absolute = path.isAbsolute(except_relative_path) ?
    except_relative_path :
    path.join(cwd, except_relative_path);
  return path.relative(base, result_absolute);
}

function frombase_path(except_relative_path) {
  const cwd = process.cwd();
  let base = path.dirname(_getCallerFileName());
  let result_absolute = path.isAbsolute(except_relative_path) ?
    except_relative_path :
    path.join(base, except_relative_path);
  return path.join(path.relative(base, cwd), path.relative(cwd, result_absolute));
}

function absolute_path(except_relative_path) {
  let base = path.dirname(_getCallerFileName());
  return path.isAbsolute(except_relative_path) ?
    except_relative_path :
    path.join(base, except_relative_path);
}

function globby_paths(globby_paths) {
  const cwd = process.cwd();
  let base = path.dirname(_getCallerFileName() || cwd);
  return globby.sync(globby_paths, { cwd: base });
}

const helper_functions = [
  ["base2local", base2local_path],
  ["frombase", frombase_path],
  ["absolute", absolute_path],
  ["glob", globby_paths]
];

exports.gen = function (config_ggyp, env_vars = {}) {
  const config_ggyp_content = fsReadFileSyncCwd(config_ggyp);
  const S = _createTreeyScope(env_vars);
  const cwd = process.cwd();

  _withProps([
    ["__S", S], // dont want user using root scope directly in the configure ggyp
    ["G", S.vars],
    ["global", (...args) => S.global(...args)],
    ["target_template", (...args) => S.target_template(...args)],
    ["$gen", (entry_dir) => {
      let base = path.dirname(stackTrace.parse(new Error())[1].fileName);

      if (Array.isArray(entry_dir)) {
        return entry_dir.forEach(entry => _read_and_run_ggyp(S, entry));
      }

      return _read_and_run_ggyp(S, path.join(entry_dir, "./BUILD.ggyp"));
    }],
    ...helper_functions
  ], `
    const scope = {};
    __S.on("METHOD_DEFINED", ([name]) => {
      scope[name] = (...args) => S[name](...args);
    });
    with(scope) {
      ${config_ggyp_content}
    }
  `.trim(), config_ggyp);

  return S.toData(true).then(data => {
    // console.log(require("util").inspect(data, { showHidden: true, depth: null }));
    const projects = data.$children.filter(([name])=> name === "project");

    for (const project of projects) {
      const [ _, project_info ] = project;
      const {
        project_path,
        project_name,
        project_options,
        project_is_includable
      } = project_info;

      const variables = project_info.variables;
      const targets = project_info.$children.filter(([name]) => name === "target");
      const json = {};

      const project_path_relative_to_base = path.relative(project_path, cwd);
      const base_relative_to_project_path = path.relative(cwd, project_path);
      const project_path_ext = path.extname(project_name);

      const assets_base = path.join(
        project_path_relative_to_base, base_relative_to_project_path
      );

      if (variables && typeof variables === "object" 
          && Object.keys(variables).length > 0) {
        json.variables = variables;
      }

      json.targets = targets.length > 0 ? targets.map(([_, target_info]) => {

        const _target_info = _rebaseAllPathsBeforeOutput(target_info, assets_base);

        return R.filter(Boolean, { 
          ..._target_info,
          $children: null
        })
      }) : void 0;

      let suffix = ".gyp";
      if (project_is_includable) {
        suffix = ".gypi";
      }
      
      if (project_info.includes) {
        json.includes = project_info.includes;
      }

      fs.writeFileSync(
        path.join(project_path, `${project_name}${suffix}`),
        JSON.stringify(json, null, 2)
      );
    }
  });
}

function _read_and_run_ggyp(S, ggyp_path) {
  const entry_content = fsReadFileSyncCwd(ggyp_path);
  _run_ggyp(S, entry_content, ggyp_path);
}

function _run_ggyp(S, code_string, ggyp_path) {
  _withProps([
    ["S", S],
    ["G", S.vars],
    ["target_template", (...args) => S.target_template(...args)],
    ["global", (...args) => S.global(...args)],
    ["project", (...args) => S.project(...args)],
    ["__curr", path.basename(ggyp_path).replace(/\.ggypi?$/, "")],
    ...helper_functions
  ], code_string, ggyp_path);
}

function _createTreeyScope(env_vars = {}) {
  const S = treey.create();

  S.vars = env_vars;

  S.def("global", _ => (global_vars) => {
    S.vars = global_vars;
  })

  S.def("project", _ => (project_name, defFn) => {
    let _defFn = defFn;
    const ggyp_file_path = _getCallerFileName();
    const project_path = path.dirname(ggyp_file_path);
    S("project", project => {
      project.project_path("");
      project.project_name("");
      project.variables.ensure_plain_object();
      _defFn(project);
      project.project_path(project_path);
      project.project_name(`${project_name}`);
      project.project_is_includable(path.extname(ggyp_file_path) === ".ggypi")
    })
  });

  S.def("target_template", _ => (template_name, defFn) => {
    S.def(template_name, scope => (target_name, defTargetFn) => {
      scope("target", target => {
        target.target_name(target_name)
        defFn(target, defTargetFn)
      });
    })
  });

  return S;
}

function _withProps(tokenPropsMap, code_string, filename_) {
  const cwd = process.cwd();
  const filename__ = path.isAbsolute(filename_) ? filename_ : path.join(cwd, filename_);
  const token = tokenPropsMap.map(([token]) => token);
  const props = tokenPropsMap.map(([token, prop, options = {}]) => prop);

  const code_module_string = `
  //console.log("code_module_string...", __filename);
  module.exports = new Function(
    ${token.map(token_string => JSON.stringify(token_string)).join(",")}, 
    ${JSON.stringify(code_string)}
  )
  `
  const Module = module.constructor;
  const m = new Module();
  m._compile(code_module_string, filename__);

  return m.exports(...props);
}

function _rebaseAllPathsBeforeOutput(target, rebase_prefix) {
  return Object.keys(target).reduce((result, key) => {
    let value = target[key];
    if (Array.isArray(value)) {
      if ([
          /.?sources$/,
          /.?dirs$/,
          /.?files$/
        ].some(regex => regex.test(key))) {
        value = value.map(element_path => path.join(rebase_prefix, element_path));
      }
    } else if (typeof value === "object") {
      value = _rebaseAllPathsBeforeOutput(value, rebase_prefix);
    }
    result[key] = value;
    return result;
  }, {})
}
