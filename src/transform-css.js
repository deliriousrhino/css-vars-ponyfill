/**
 * Based on rework-vars by reworkcss
 * https://github.com/reworkcss/rework-vars
 */


// Dependencies
// =============================================================================
import balanced     from 'balanced-match';
import mergeDeep    from './merge-deep';
import parseCss     from './parse-css';
import stringifyCss from './stringify-css';
import walkCss      from './walk-css';


// Constants & Variables
// =============================================================================
const VAR_PROP_IDENTIFIER = '--';
const VAR_FUNC_IDENTIFIER = 'var';
const reVarProp = /^--/;
const reVarVal  = /^var(.*)/;


// Functions
// =============================================================================
/**
 * Transforms W3C-style CSS variables to static values and returns an updated
 * CSS string.
 *
 * @param {object}   cssText CSS containing variable definitions and functions
 * @param {object}   [options] Options object
 * @param {boolean}  [options.onlyVars=true] Remove declarations that do not
 *                   contain a CSS variable from the return value. Note that
 *                   @font-face and @keyframe rules require all declarations to
 *                   be returned if a CSS variable is used.
 * @param {boolean}  [options.preserve=true] Preserve CSS variable definitions
 *                   and functions in the return value, allowing "live" variable
 *                   updates via JavaScript to continue working in browsers with
 *                   native CSS variable support.
 * @param {object}   [options.variables={}] CSS variable definitions to include
 *                   during transformation. Can be used to add new override
 *                   exisitng definitions.
 * @param {function} [options.onWarning] Callback on each transformation
 *                   warning. Passes 1) warningMessage as an argument.
 * @returns {string}
 */
function transformVars(cssText, options = {}) {
    const defaults = {
        onlyVars : true,
        preserve : true,
        variables: {},
        onWarning() {}
    };
    const map      = {};
    const settings = mergeDeep(defaults, options);

    // Convert cssText to AST (this could throw errors)
    const cssTree = parseCss(cssText);

    // Remove non-vars
    if (settings.onlyVars) {
        cssTree.stylesheet.rules = filterVars(cssTree.stylesheet.rules);
    }

    // Define variables
    cssTree.stylesheet.rules.forEach(function(rule) {
        const varNameIndices = [];

        if (rule.type !== 'rule') {
            return;
        }

        // only variables declared for `:root` are supported
        if (rule.selectors.length !== 1 || rule.selectors[0] !== ':root') {
            return;
        }

        rule.declarations.forEach(function(decl, i) {
            const prop = decl.property;
            const value = decl.value;

            if (prop && prop.indexOf(VAR_PROP_IDENTIFIER) === 0) {
                map[prop] = value;
                varNameIndices.push(i);
            }
        });

        // optionally remove `--*` properties from the rule
        if (!settings.preserve) {
            for (let i = varNameIndices.length - 1; i >= 0; i--) {
                rule.declarations.splice(varNameIndices[i], 1);
            }
        }
    });

    // Handle variables defined in settings.variables
    if (Object.keys(settings.variables).length) {
        const newRule = {
            declarations: [],
            selectors   : [':root'],
            type        : 'rule'
        };

        Object.keys(settings.variables).forEach(function(key) {
            // Normalize variables by ensuring all start with leading '--'
            const varName  = `--${key.replace(/^-+/, '')}`;
            const varValue = settings.variables[key];

            // Update internal map value with settings.variables value
            map[varName] = varValue;

            // Add new declaration to newRule
            newRule.declarations.push({
                type    : 'declaration',
                property: varName,
                value   : varValue
            });
        });

        // Append new :root ruleset
        if (settings.preserve) {
            cssTree.stylesheet.rules.push(newRule);
        }
    }

    // Resolve variables
    walkCss(cssTree.stylesheet, function(declarations, node) {
        let decl;
        let resolvedValue;
        let value;

        for (let i = 0; i < declarations.length; i++) {
            decl = declarations[i];
            value = decl.value;

            // skip comments
            if (decl.type !== 'declaration') {
                continue;
            }

            // skip values that don't contain variable functions
            if (!value || value.indexOf(VAR_FUNC_IDENTIFIER + '(') === -1) {
                continue;
            }

            resolvedValue = resolveValue(value, map, settings);

            if (resolvedValue !== 'undefined') {
                if (!settings.preserve) {
                    decl.value = resolvedValue;
                }
                else {
                    declarations.splice(i, 0, {
                        type    : decl.type,
                        property: decl.property,
                        value   : resolvedValue
                    });

                    // skip ahead of preserved declaration
                    i++;
                }
            }
        }
    });

    // Return CSS string
    return stringifyCss(cssTree);
}


// Functions (Private)
// =============================================================================
/**
 * Filters rules recursively, retaining only declarations that contain either a
 * CSS variable definition (property) or function (value). Maintains all
 * declarations for @font-face and @keyframes rules that contain a CSS
 * definition or function.
 *
 * @param {array} rules
 * @returns {array}
 */
function filterVars(rules) {
    return rules.filter(rule => {
        // Rule, @font-face, @host, @page
        if (rule.declarations) {
            // @font-face rules require all declarations to be retained if any
            // declaration contains a CSS variable definition or value.
            // For other rules, any declaration that does not contain a CSS
            // variable can be removed.
            let declArray = rule.type === 'font-face' ? [] : rule.declarations;

            declArray = rule.declarations.filter(d => reVarProp.test(d.property) || reVarVal.test(d.value));

            return Boolean(declArray.length);
        }
        // @keyframes
        else if (rule.keyframes) {
            // @keyframe rules require all declarations to be retained if any
            // declaration contains a CSS variable definition or value.
            return Boolean(rule.keyframes.filter(k =>
                Boolean(k.declarations.filter(d => reVarProp.test(d.property) || reVarVal.test(d.value)).length)
            ).length);
        }
        // @document, @media, @supports
        else if (rule.rules) {
            rule.rules = filterVars(rule.rules).filter(r => r.declarations.length);

            return Boolean(rule.rules.length);
        }

        return true;
    });
}

/**
 * Resolve CSS variables in a value
 *
 * The second argument to a CSS variable function, if provided, is a fallback
 * value, which is used as the substitution value when the referenced variable
 * is invalid.
 *
 * var(name[, fallback])
 *
 * @param {string} value A property value containing a CSS variable function
 * @param {object} map A map of variable names and values
 * @param {object} settings Settings object passed from transformVars()
 * @return {string} A new value with CSS variables substituted or using fallback
 */
function resolveValue(value, map, settings) {
    // matches `name[, fallback]`, captures 'name' and 'fallback'
    const RE_VAR = /([\w-]+)(?:\s*,\s*)?(.*)?/;
    const balancedParens = balanced('(', ')', value);
    const varStartIndex  = value.indexOf('var(');
    const varRef         = balanced('(', ')', value.substring(varStartIndex)).body;
    const warningIntro   = 'CSS transform warning:';

    /* istanbul ignore next */
    if (!balancedParens) {
        settings.onWarning(`${warningIntro} missing closing ")" in the value "${value}"`);
    }

    /* istanbul ignore next */
    if (varRef === '') {
        settings.onWarning(`${warningIntro} var() must contain a non-whitespace string`);
    }

    const varFunc = VAR_FUNC_IDENTIFIER + '(' + varRef + ')';

    const varResult = varRef.replace(RE_VAR, function(_, name, fallback) {
        const replacement = map[name];

        if (!replacement && !fallback) {
            settings.onWarning(`${warningIntro} variable "${name}" is undefined`);
        }

        if (!replacement && fallback) {
            return fallback;
        }

        return replacement;
    });

    // resolve the variable
    value = value.split(varFunc).join(varResult);

    // recursively resolve any remaining variables in the value
    if (value.indexOf(VAR_FUNC_IDENTIFIER) !== -1) {
        value = resolveValue(value, map, settings);
    }

    return value;
}


// Exports
// =============================================================================
export default transformVars;