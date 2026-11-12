import {mkdir,writeFile,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const dir=path.resolve('.local/tools');await mkdir(dir,{recursive:true});
const files=[['colima','https://github.com/abiosoft/colima/releases/download/v0.10.3/colima-Darwin-arm64'],['lima.tar.gz','https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz'],['docker-compose','https://github.com/docker/compose/releases/download/v5.6.1/docker-compose-darwin-aarch64'],['docker.tar.gz','https://download.docker.com/mac/static/stable/aarch64/docker-29.0.0.tgz']];
for(const [name,url] of files){console.log('Downloading',name);const r=await fetch(url);if(!r.ok)throw new Error(`${name}: ${r.status}`);await writeFile(path.join(dir,name),Buffer.from(await r.arrayBuffer()));if(!name.endsWith('.gz'))await chmod(path.join(dir,name),0o755);else execFileSync('tar',['-xzf',path.join(dir,name),'-C',dir]);}
console.log('Runtime tools downloaded',dir);
