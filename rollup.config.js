import babel from 'rollup-plugin-babel';
import commonjs from 'rollup-plugin-commonjs';
import resolve from 'rollup-plugin-node-resolve';
import path from 'path';
import {terser} from 'rollup-plugin-terser';
import serve from 'rollup-plugin-serve';
import json from '@rollup/plugin-json';
import ts from 'rollup-plugin-typescript2';
import livereload from 'rollup-plugin-livereload';
import obfuscatorPlugin from "rollup-plugin-javascript-obfuscator";
// import obfuscator from 'rollup-plugin-obfuscator';
// import { obfuscator } from 'rollup-obfuscator';
export default {
    input: "./src/index.ts",
    output: [
        {
            file: './dist/bm-plot.js',
            format: 'umd',
            name: 'WayBack',
            //当入口文件有export时，'umd'格式必须指定name
            //这样，在通过<script>标签引入时，才能通过name访问到export的内容。
        },
    ],
    external: [],
    plugins: [
        ts({
            tsconfig: path.resolve(__dirname, 'tsconfig.json')
        }),
        serve({
            host: '127.0.0.1',
            contentBase: '',  //服务器启动的文件夹，默认是项目根目录，需要在该文件下创建index.html
            port: 8020   //端口号，默认10001
        }),
        livereload('dist'),   //watch dist目录，当目录中的文件发生变化时，刷新页面
        // obfuscator({
        //     options: {
        //         // Your javascript-obfuscator options here
        //         // See what's allowed: https://github.com/javascript-obfuscator/javascript-obfuscator
        //     },
        // }),
        // terser(),
        // obfuscator(),
        json(),
        resolve(),
        commonjs(),
        babel({
            exclude: 'node_modules/**'
        }),
    ]
}
