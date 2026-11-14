import { useEffect, useState } from 'react'
import type { Resume } from '../../../shared/types'

const lines = (s: string): string[] => s.split('\n').map(x => x.replace(/^\s*[•\-*]\s*/, '').trim()).filter(Boolean)

function F({ label, value, onChange, area, rows }: { label: string; value: string; onChange: (v: string) => void; area?: boolean; rows?: number }) {
  return (
    <label className="f"><span>{label}</span>
      {area ? <textarea rows={rows || 3} value={value} onChange={e => onChange(e.target.value)} /> : <input value={value} onChange={e => onChange(e.target.value)} />}
    </label>
  )
}

/** Edited as free text (one item per line, or comma-separated) and kept in sync when the list changes from outside. */
function ListText({ label, items, onChange, comma }: { label: string; items: string[]; onChange: (v: string[]) => void; comma?: boolean }) {
  const parse = (t: string): string[] => (comma ? t.split(',').map(x => x.trim()).filter(Boolean) : lines(t))
  const join = (a: string[]): string => a.join(comma ? ', ' : '\n')
  const [text, setText] = useState(join(items))
  useEffect(() => { if (join(parse(text)) !== join(items)) setText(join(items)) }, [items])
  const edit = (t: string): void => { setText(t); onChange(parse(t)) }
  return (
    <label className="f"><span>{label}</span>
      {comma ? <input value={text} onChange={e => edit(e.target.value)} /> : <textarea rows={Math.max(2, items.length + 1)} value={text} onChange={e => edit(e.target.value)} />}
    </label>
  )
}
const Bullets = (p: { label: string; items: string[]; onChange: (v: string[]) => void }) => <ListText {...p} label={`${p.label} (one per line)`} />

export function ResumeEditor({ value, onChange }: { value: Resume; onChange: (r: Resume) => void }) {
  const set = (patch: Partial<Resume>): void => onChange({ ...value, ...patch })
  function list<K extends 'education' | 'experience' | 'projects' | 'skills' | 'extras'>(key: K) {
    const arr = value[key] as any[]
    return {
      upd: (i: number, patch: object) => set({ [key]: arr.map((x, n) => (n === i ? { ...x, ...patch } : x)) } as Partial<Resume>),
      del: (i: number) => set({ [key]: arr.filter((_, n) => n !== i) } as Partial<Resume>),
      up: (i: number) => { if (i > 0) { const c = arr.slice(); [c[i - 1], c[i]] = [c[i], c[i - 1]]; set({ [key]: c } as Partial<Resume>) } },
      add: (item: object) => set({ [key]: [...arr, item] } as Partial<Resume>)
    }
  }
  const tools = (l: { del: (i: number) => void; up: (i: number) => void }, i: number) => (
    <div className="rowx" style={{ justifyContent: 'flex-end' }}>
      <button className="btn ghost sm" onClick={() => l.up(i)} disabled={i === 0}>Move up</button>
      <button className="btn ghost sm" onClick={() => l.del(i)}>Remove</button>
    </div>
  )
  const edu = list('education'), exp = list('experience'), proj = list('projects'), sk = list('skills'), ex = list('extras')
  const c = value.contact
  const setC = (patch: Partial<Resume['contact']>): void => set({ contact: { ...c, ...patch } })

  return (
    <div>
      <div className="card"><h3>Contact</h3>
        <div className="stack">
          <div className="grid2"><F label="Name" value={value.name} onChange={v => set({ name: v })} /><F label="Email" value={c.email} onChange={v => setC({ email: v })} /></div>
          <div className="grid2"><F label="Phone" value={c.phone} onChange={v => setC({ phone: v })} /><F label="Location" value={c.location} onChange={v => setC({ location: v })} /></div>
          <div className="grid2"><F label="LinkedIn" value={c.linkedin} onChange={v => setC({ linkedin: v })} /><F label="Website or portfolio" value={c.website} onChange={v => setC({ website: v })} /></div>
          <F label="Summary (optional)" value={value.summary} onChange={v => set({ summary: v })} area rows={2} />
        </div>
      </div>
      <div className="card"><h3>Education</h3>
        <div className="stack">
          {value.education.map((e, i) => (
            <div className="entry" key={i}>
              <div className="grid2"><F label="School" value={e.school} onChange={v => edu.upd(i, { school: v })} /><F label="Dates" value={e.dates} onChange={v => edu.upd(i, { dates: v })} /></div>
              <F label="Degree" value={e.degree} onChange={v => edu.upd(i, { degree: v })} />
              <Bullets label="Details" items={e.details} onChange={v => edu.upd(i, { details: v })} />
              {tools(edu, i)}
            </div>
          ))}
          <div><button className="btn sm" onClick={() => edu.add({ school: '', degree: '', dates: '', details: [] })}>Add education</button></div>
        </div>
      </div>
      <div className="card"><h3>Experience</h3>
        <div className="stack">
          {value.experience.map((e, i) => (
            <div className="entry" key={i}>
              <div className="grid2"><F label="Title" value={e.title} onChange={v => exp.upd(i, { title: v })} /><F label="Company or team" value={e.company} onChange={v => exp.upd(i, { company: v })} /></div>
              <div className="grid2"><F label="Location" value={e.location} onChange={v => exp.upd(i, { location: v })} /><F label="Dates" value={e.dates} onChange={v => exp.upd(i, { dates: v })} /></div>
              <Bullets label="Bullets" items={e.bullets} onChange={v => exp.upd(i, { bullets: v })} />
              {tools(exp, i)}
            </div>
          ))}
          <div><button className="btn sm" onClick={() => exp.add({ company: '', title: '', location: '', dates: '', bullets: [] })}>Add experience</button></div>
        </div>
      </div>
      <div className="card"><h3>Projects</h3>
        <div className="stack">
          {value.projects.map((p, i) => (
            <div className="entry" key={i}>
              <div className="grid3"><F label="Name" value={p.name} onChange={v => proj.upd(i, { name: v })} /><F label="Tools" value={p.tech} onChange={v => proj.upd(i, { tech: v })} /><F label="Dates" value={p.dates} onChange={v => proj.upd(i, { dates: v })} /></div>
              <Bullets label="Bullets" items={p.bullets} onChange={v => proj.upd(i, { bullets: v })} />
              {tools(proj, i)}
            </div>
          ))}
          <div><button className="btn sm" onClick={() => proj.add({ name: '', dates: '', tech: '', bullets: [] })}>Add project</button></div>
        </div>
      </div>
      <div className="card"><h3>Skills</h3>
        <div className="stack">
          {value.skills.map((s, i) => (
            <div className="entry" key={i}>
              <F label="Category" value={s.category} onChange={v => sk.upd(i, { category: v })} />
              <ListText comma label="Items (comma-separated)" items={s.items} onChange={v => sk.upd(i, { items: v })} />
              {tools(sk, i)}
            </div>
          ))}
          <div><button className="btn sm" onClick={() => sk.add({ category: '', items: [] })}>Add skill group</button></div>
        </div>
      </div>
      <div className="card"><h3>Other sections</h3>
        <div className="stack">
          {value.extras.map((x, i) => (
            <div className="entry" key={i}>
              <F label="Heading" value={x.heading} onChange={v => ex.upd(i, { heading: v })} />
              <Bullets label="Items" items={x.items} onChange={v => ex.upd(i, { items: v })} />
              {tools(ex, i)}
            </div>
          ))}
          <div><button className="btn sm" onClick={() => ex.add({ heading: '', items: [] })}>Add section</button></div>
        </div>
      </div>
    </div>
  )
}
