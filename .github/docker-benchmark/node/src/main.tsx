import {createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {z} from 'zod'
import {version} from './version'
const projects = z.array(z.object({name:z.string(),status:z.enum(['ready','building'])})).parse([{name:'Web',status:'ready'},{name:'API',status:'building'}])
createRoot(document.getElementById('root')!).render(createElement('main',null,createElement('h1',null,version),...projects.map(project=>createElement('p',{key:project.name},`${project.name}: ${project.status}`))))
