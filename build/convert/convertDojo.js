/**
 * Converts dojo modules to be runjs compliant modules. Only works with dojo,
 * dijit and dojox modules, not for custom namespaces.
 *
 * Non-build file changes:
 * * In dojo._base.query, move the provide/require calls to the top
 * * dojo/_base.js convert requireIf to dojo.require("dojo._base.browser");
 * * dojo/_base/hostenv_browser.js, remove the debugAtAllCosts block and change
 * the isDebug block to be if(dojo.config.isDebug){run(["dojo._firebug.firebug"]);}
 * * In dijit/_editor/RichText.js, remove the allowXdRichTextSave block, or force it not to doc.write.
 *
 * It requires a Dojo build that:
 * * has buildUtil.addGuardsAndBaseRequires not do anything. So it will not work
 * with customDojoBase builds. It also means modifying buildUtil.addGuardsAndBaseRequires
 * to just return instead of doing its work.
 * * Comment out the inclusion of dojoGuardStart.jsfrag and dojoGuardEnd.jsfrag
 * in buildUtil.js.
 * * In dojo._base.query, move the provide/require calls to the top
 * * After the build put a dependency in dijit.dijit-all for dijit.dijit to get reloads in IE to work.
 * 
 * Usage:
 * java -classpath path/to/rhino/js.jar convertDojo.js path/to/dojo rundojo
 *
 */
/*jslint plusplus: false */
/*global load: false, fileUtil: false, logger: false, Packages: false, convert: true */

"use strict";

load("../jslib/fileUtil.js");
load("../jslib/logger.js");

var startTime = (new Date()).getTime(),
    convertTime,
    dojoPath = arguments[0],
    savePath = arguments[1],
    //Get list of files to convert.
    fileList = fileUtil.getFilteredFileList(dojoPath, /\w/, true),
    jsFileRegExp = /\.js$/,
    depRegExp = /dojo\s*\.\s*(provide|require)\s*\(\s*["']([\w-_\.]+)["']\s*\)/g,
    reqRemoveRegExp = /dojo\s*\.\s*require\s*\(\s*["']([\w-_\.]+)["']\s*\)/g,
    dojoJsRegExp = /\/dojo\.js(\.uncompressed\.js)?$/,
    fileName, convertedFileName, fileContents,
    i;

//Normalize on front slashes and make sure the paths do not end in a slash.
dojoPath = dojoPath.replace(/\\/g, "/");
savePath = savePath.replace(/\\/g, "/");
if (dojoPath.charAt(dojoPath.length - 1) === "/") {
    dojoPath = dojoPath.substring(0, dojoPath.length - 1);
}
if (savePath.charAt(savePath.length - 1) === "/") {
    savePath = savePath.substring(0, savePath.length - 1);
}

//Cycle through all the JS files and convert them.
if (!fileList || !fileList.length) {
    if (dojoPath === "convert") {
        //A request just to convert one file.
        logger.trace('\n\n' + convert(savePath, fileUtil.readFile(savePath)));
    } else {
        logger.error("No files to convert in directory: " + dojoPath);
    }
} else {
    for (i = 0; (fileName = fileList[i]); i++) {
        convertedFileName = fileName.replace(dojoPath, savePath);
        //Only do JS files and skip i18n bundles for now.
        if (jsFileRegExp.test(fileName) && fileName.indexOf("/nls/") === -1) {
            fileContents = fileUtil.readFile(fileName);
            fileContents = convert(fileName, fileContents);
            fileUtil.saveUtf8File(convertedFileName, fileContents);
        } else {
            //Just copy the file over.
            fileUtil.copyFile(fileName, convertedFileName, true);
        }
    }
}

//Write a baseline dojo.js file. Adjust the baseUrlRegExp to look for dojo.js,
//which should be a sibling of run.js.

fileContents = 'run.baseUrlRegExp = /dojo(\\.xd)?\\.js(\\W|$)/i;' +
               fileUtil.readFile(savePath + "/dojo/_base/_loader/bootstrap.js") +
               fileUtil.readFile(savePath + "/dojo/_base/_loader/loader.js") +
               fileUtil.readFile(savePath + "/dojo/_base/_loader/hostenv_browser.js");

fileContents += 'run("dojo", function(){return dojo;});run("dijit", function(){return dijit;});run("dojox", function(){return dojox;});';

fileUtil.saveUtf8File(savePath + "/dojo.js", fileContents);

convertTime = ((new Date().getTime() - startTime) / 1000);
logger.info("Convert time: " + convertTime + " seconds");

function writeRunEnd(prefixProps, contents) {
    var reqString = "", argString = "", i, req;

    if (!prefixProps) {
        return contents;
    } else {
        //Convert dojo.cache references to be text! dependencies.
        contents = contents.replace(/dojo\s*\.\s*cache\s*\(['"]([^'"]+)['"]\s*\,\s*['"]([^'"]+)['"]\s*\)/g, function(match, modName, fileName) {
            var textName = "text!" + modName.replace(/\./g, "/") + "/" + fileName;
            //Make sure to use a bang for file extension part.
            textName = textName.split(".").join("!");

            prefixProps.reqs.push(textName);
            return '_R' + (prefixProps.reqs.length - 1);
        });

        //Build up the req string and args string.
        for (i = 0; req = prefixProps.reqs[i]; i++) {
            reqString += ', "' + req + '"';
            argString += ', _R' + i;
        }

        return 'run("' + prefixProps.provide + '", ["run", "dojo", "dijit", "dojox"' +
                reqString +
                '], function(run, dojo, dijit, dojox' + argString + ') {\n' +
                prefixProps.match +
                contents +
                '\nreturn ' + (prefixProps.provide.indexOf("-") === -1 ? prefixProps.provide : "null") + '; });\n';
    }
}

/**
 * Does the actual file conversion.
 *
 * @param {String} fileName the name of the file.
 * 
 * @param {String} fileContents the contents of a file :)
 */
function convert(fileName, fileContents) {
    //Strip out comments.
    logger.trace("fileName: " + fileName);
    try {
        var originalContents = fileContents,
            context = Packages.org.mozilla.javascript.Context.enter(), match,
            //deps will be an array of objects like {provide: "", requires:[]}
            deps = [],
            currentDep, depName, provideRegExp,
            module, allDeps, reqs = [], prefixProps,
            i, j, removeString = "", removeRegExp,
            markIndex = 0, lastIndex = 0,
            opt = context.setOptimizationLevel(-1),
            script = context.compileString(fileContents, fileName, 1, null),
            //Remove comments
            tempContents = String(context.decompileScript(script, 0));

        depRegExp.lastIndex = 0;
        deps.provides = {};
    
        while ((match = depRegExp.exec(tempContents))) {
            //Find the list of dojo.provide and require calls.
            module = match[2];
            logger.trace("  " + match[1] + " " + module);
            if (module) {
                depName = match[1];
                if (depName === "provide") {
                    currentDep = {
                        provide: module,
                        requires: []
                    };
                    deps.push(currentDep);
                    //Store a quick lookup about what provide modules are available.
                    deps.provides[module] = 1;
                } else if (currentDep) {
                    //If no currentDep, as in dojo.js having the firebug call, skip it.
                    currentDep.requires.push(module);
                }
            }
        }

        if (deps.length) {
            //Work with original file and remove the require calls.
            fileContents = originalContents.replace(reqRemoveRegExp, "");

            //Wrap each section with a dojo.provide with a run block
            markIndex = 0;
            tempContents = "";

            //If dojo.js, inject run.js at the top of the file, then
            //tell run to pause on tracing dependencies until the
            //full file is evaluated.
            if (fileName.match(dojoJsRegExp)) {
                tempContents = fileUtil.readFile("../../run.js");
            }

            if (deps.length > 1) {
                tempContents += 'run.pause();\n';
            }

            for (i = 0; (currentDep = deps[i]); i++) {
                 //Find the provide call in the real source, not the temp source
                //that has comments removed.
                provideRegExp = new RegExp('dojo\\s*\\.\\s*provide\\s*\\(\\s*["\']' +
                                            currentDep.provide.replace(/\./g, "\\.") + 
                                           '["\']\\s*\\)', 'g');
                provideRegExp.lastIndex = markIndex;
                match = provideRegExp.exec(fileContents)[0];
                lastIndex = provideRegExp.lastIndex - match.length;
    
                //Write out the current run block (or just first block of text.
                tempContents += writeRunEnd(prefixProps, fileContents.substring(markIndex, lastIndex));

                //Build up the run dependencies.
                reqs = [];
                for (j = 0; (module = currentDep.requires[j]); j++) {
                    if (!deps.provides[module]) {
                        reqs.push(module)
                    }
                }

                //Save the properties to use for the run() prefix code
                prefixProps = {
                    provide: currentDep.provide,
                    reqs: reqs,
                    match: match
                };

                //Move the file cursor.
                markIndex = provideRegExp.lastIndex;
            }

            //Write out the last of the file with ending segment for run.
            tempContents += writeRunEnd(prefixProps, fileContents.substring(markIndex, fileContents.length));
        }

        if (deps.length > 1) {
            tempContents += 'run.resume();\n';
        }

        return tempContents;
    } catch (e) {
        logger.error("COULD NOT CONVERT: " + fileName + ", so skipping it. Error was: " + e);
        return originalContents;
    }

    return fileContents;
}
