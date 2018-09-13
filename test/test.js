/* Created by tommyZZM.OSX on 2018/9/13. */
"use strict";
const fs = require("fs");
const path = require("path");
const ggyp = require("../");
const base = path.join(__dirname, "fixtures");
const { expect } = require("chai")

ggyp.gen(path.join(base, ".ggyp"), {});

const result_actual = fs.readFileSync(path.join(base, "test1.gyp"))
const result_expect = fs.readFileSync(path.join(base, "test1.gyp_"))

expect(result_actual).to.be.deep.equal(result_expect);
