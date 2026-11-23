import type { RawJob, Region } from '../shared/types'
import { KNOWN, US_DEFENSE } from './companies'

const ONTARIO = /\b(ontario|toronto|ottawa|mississauga|brampton|hamilton|waterloo|kitchener|cambridge, on|london, on|markham|vaughan|oakville|burlington|oshawa|windsor, on|guelph|kingston, on|barrie|sudbury|thunder bay|st\.? catharines|niagara|richmond hill|ajax|pickering|whitby|milton, on|kanata|peterborough|sarnia|woodstock, on|alliston|ingersoll|aurora, on|newmarket|concord, on|etobicoke|scarborough|north york|stoney creek|brantford|chatham|belleville|cornwall, on|bolton, on|tiverton|chalk river|clarington|darlington|gta)\b|,\s*ON\b|\bON,\s*(CA|CAN|Canada)\b/i
const CANADA = /\b(canada|quebec|québec|montreal|montréal|british columbia|vancouver|alberta|calgary|edmonton|manitoba|winnipeg|saskatchewan|saskatoon|regina|nova scotia|halifax|new brunswick|newfoundland|victoria, bc|burnaby|richmond, bc|laval|longueuil|mirabel|saint-laurent|dorval)\b|,\s*(QC|BC|AB|MB|SK|NS|NB|NL|PE)\b|\bCAN\b/i
const US_STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'
const US_NAMES = 'alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio oklahoma oregon pennsylvania rhode island|south carolina|south dakota|tennessee texas utah vermont virginia washington west virginia|wisconsin wyoming'
const USA = new RegExp(`\\b(united states|usa|u\\.s\\.a?\\.?|us-[a-z]{2}|${US_NAMES.replace(/ (?![a-z]+\|)/g, '|')})\\b|,\\s*(${US_STATES.split(' ').join('|')})\\b|\\bUS\\b|\\b(${US_STATES.split(' ').join('|')})\\s*-\\s|\\bUS,|-\\s*US\\b`, 'i')
const ELSEWHERE = /\b(india|china|japan|korea|germany|france|united kingdom|uk|england|ireland|mexico|brazil|singapore|taiwan|israel|poland|netherlands|australia|new zealand|italy|spain|sweden|switzerland|malaysia|philippines|vietnam|thailand|czech|hungary|romania|austria|belgium|denmark|norway|finland|portugal|turkey|uae|dubai|saudi|egypt|south africa|costa rica|colombia|argentina|chile|bangalore|bengaluru|hyderabad|pune|chennai|shanghai|beijing|shenzhen|tokyo|munich|berlin|paris|london, (uk|england)|penang|auckland|armenia|yerevan|georgia, (ge|tbilisi)|tbilisi|bulgaria|croatia|estonia|latvia|lithuania|slovenia|iceland|cyprus|malta|luxembourg|slovakia|taipei|tel aviv|haifa|dublin|eemshaven|hong kong|indonesia|qatar|serbia|greece|ukraine|peru|morocco|kenya|nigeria|pakistan|bangladesh|sri lanka)\b/i
// United Kingdom. A UK job is kept only at a well-known employer (KNOWN), the same bar as US jobs outside the four key areas.
const UK = /\b(united kingdom|great britain|england|scotland|(?<!new south )wales|northern ireland|london|manchester|birmingham|bristol|derby|coventry|sheffield|leeds|glasgow|edinburgh|belfast|filton|broughton|swindon|milton keynes|gaydon|solihull|whitley|crewe|woking|silverstone|brackley|malmesbury|hullavington|culham|abingdon|stevenage|southampton|nottingham|liverpool|cardiff|aberdeen|newcastle upon tyne|sunderland|cambridge,\s*(uk|england|gb)|oxford,\s*(uk|england|gb)|reading,\s*(uk|england|berkshire))\b|\b(UK|GB|GBR)\b/i
// Three-letter country codes, as Amazon and Boeing write them ("Luxembourg, LUX", "GBR - Hounslow").
const ISO3_ELSEWHERE = /\b(SGP|LUX|DEU|ITA|POL|IND|JPN|CHN|FRA|ESP|MEX|BRA|AUS|IRL|NLD|ISR|KOR|TWN|CZE|ROU|CRI|ARE|SAU|ZAF|QAT|MYS|PHL|SWE|CHE|BEL|AUT|TUR|EGY|COL|ARG|CHL|SVK|HUN|PRT|DNK|NOR|FIN|NZL|VNM|THA|IDN|HKG|SRB|GRC|UKR|BGR|JOR|BHR|KWT|OMN|MAR)\b/

// The four US areas where lesser-known employers are still kept. New York means the city, not the state.
const KEY_US = new RegExp([
  String.raw`\b(california|texas|florida|new york city|nyc|new york,\s*(ny|new york)|brooklyn|manhattan|queens|bronx|long island city|staten island)\b`,
  String.raw`,\s*(CA|TX|FL)\b(?!\s*,\s*(CA|CAN|Canada)\b)|\b(CA|TX|FL)\s*-\s|\bUS-(CA|TX|FL)\b`,
  String.raw`\b(san francisco|los angeles|san diego|san jose|palo alto|mountain view|sunnyvale|santa clara|cupertino|hawthorne|el segundo|long beach|irvine|fremont|oakland|menlo park|redwood city|torrance|costa mesa|santa monica|pasadena|bay area|silicon valley|foster city|san mateo|san carlos|alameda|emeryville|berkeley|burbank|culver city|gardena|vandenberg|mojave|sacramento|austin|houston|dallas|san antonio|fort worth|starbase|el paso|plano|cape canaveral|orlando|miami|tampa|jacksonville|kennedy space center|merritt island)\b`
].join('|'), 'i')
/** True when a US location is in California, Texas, Florida or New York City. */
export const inKeyUsArea = (location: string): boolean => KEY_US.test(location || '')
/** UK jobs are kept only at well-known employers. */
export const ukAllowed = (company: string): boolean => KNOWN.has(company)
/** Whether a job's US location is allowed for this employer: anywhere for household names, the four key areas for everyone else. */
export const usAllowed = (company: string, location: string): boolean => KNOWN.has(company) || inKeyUsArea(location)
// Big employers that post one pooled internship for all teams, with a description too general to mention mechanical work.
const POOLED = /\b(product design|hardware|manufacturing design)\b.*\bundergrad/i

// ---- Work-term length. The candidate only wants terms of TERM.min to TERM.max months (Profile › Term length).
export const TERM = { min: 4, max: 8 }
/** Shortest internship that is always kept: a 12-week summer term. */
const SUMMER_WEEKS = 12
/** Reads a range like "4-8 months" or "8 to 12 months" from the profile; leaves the default when it cannot. */
export function setTermFromProfile(text: string): void {
  const r = durations(text, false)[0]
  if (r && r[0] >= 1 && r[1] <= 24) { TERM.min = r[0]; TERM.max = r[1] }
}
const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, 'twenty-four': 24 }
const NUM = `(\\d{1,2}|${Object.keys(WORDNUM).join('|')})`
const DUR = new RegExp(`\\b${NUM}(?:\\s*(?:-|–|—|to|or)\\s*${NUM})?[\\s-]*(weeks?|wks?|months?|mos?)\\b`, 'gi')
// Words that show a duration is about the work term, and words that show it is about something else.
const ABOUT_TERM = /intern|co-?op|\bterm\b|placement|program|duration|lasting|last for|assignment|available|availability|at least|minimum|summer|winter|fall|spring|full-?time/i
const NOT_TERM = /vacation|paid time|\bpto\b|leave|holiday|sick|experience|graduat|within|prior|previous|notice|probation|benefit|bonus|every|per year|tenure|after|ago|past|onboarding|training period|parental|warranty|contract renewal/i
const n2 = (s: string): number => (/^\d+$/.test(s) ? Number(s) : WORDNUM[s.toLowerCase()] ?? NaN)
/** Work-term lengths stated in text, as [shortest, longest] in months. With needContext, only durations near term words count. */
export function durations(text: string, needContext = true): [number, number][] {
  const out: [number, number][] = []
  for (const m of (text || '').matchAll(DUR)) {
    const at = m.index ?? 0
    const before = text.slice(Math.max(0, at - 60), at), after = text.slice(at + m[0].length, at + m[0].length + 45)
    if (needContext && (!ABOUT_TERM.test(before + ' ' + m[0] + ' ' + after) || NOT_TERM.test(before.slice(-35) + ' ' + after.slice(0, 30)))) continue
    let a = n2(m[1])
    const b = m[2] ? n2(m[2]) : a
    // A list of lengths ("4, 8, 12 or 16 month term") offers its shortest too.
    const list = before.match(/(?:\b\d{1,2}\s*(?:,|or|and|\/)\s*)+$/)
    if (list) for (const x of list[0].match(/\d{1,2}/g) || []) a = Math.min(a, Number(x))
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b < a) continue
    const weeks = /^w/i.test(m[3])
    if (weeks && (a < 6 || b > 60)) continue   // "3 weeks" is never a work term
    const f = weeks ? 1 / 4.33 : 1
    out.push([Math.round(a * f * 10) / 10, Math.round(b * f * 10) / 10])
  }
  return out
}
/** Why a posting's term length rules it out, or '' when it fits or says nothing about length. */
export function termProblem(title: string, description: string): string {
  // PEY (Professional Experience Year) is a 12 to 16 month placement.
  if (/\bPEY\b|professional experience year/i.test(title)) return 'PEY placement (12 to 16 months)'
  // UK placement years (sandwich year, year in industry) run about 12 months.
  if (/placement year|year[- ]in[- ]industry|industrial placement|sandwich (year|placement)|year[- ]long placement/i.test(title)) return 'UK placement year (about 12 months)'
  const stated = [...durations(title, false), ...durations(description)]
  if (!stated.length) return ''
  // A posting fits when any length it offers overlaps the wanted range (16 weeks counts as 4 months).
  // A 12-week summer internship is always wanted too, whatever the range says.
  const min = Math.min(TERM.min, SUMMER_WEEKS / 4.33)
  if (stated.some(([lo, hi]) => hi >= min - 0.05 && lo <= TERM.max + 0.35)) return ''
  const shown = stated[0][0] === stated[0][1] ? `${stated[0][0]}` : `${stated[0][0]} to ${stated[0][1]}`
  return `${shown}-month term, outside 12 weeks to ${TERM.max} months`
}

// ---- U.S.-person-only roles (export control, ITAR, clearance, citizenship or permanent residence required).
const US_PERSON = [
  /\bU\.?\s?S\.?\s+persons?\b/i,
  /\bITAR\b|international traffic in arms/i,
  /export[- ]control(led)?\b[^.]{0,120}\b(requir|must|eligib|access)|\b(requir|must|eligib|access)[^.]{0,120}export[- ]control/i,
  /\b(must|required to|requires?|need to)\b[^.]{0,60}\bU\.?\s?S\.?\s+(citizen|citizenship|national)/i,
  /\bU\.?\s?S\.?\s+citizenship\b[^.]{0,40}\b(is |are )?(required|a (pre-?requisite|requirement)|needed)/i,
  // Only a U.S. clearance: Canadian site-access or government clearances are open to the candidate.
  /\b(U\.?\s?S\.?|DoD|DOD|department of defense)\b[^.]{0,40}\bclearance\b|\bclearance\b[^.]{0,60}\bU\.?\s?S\.?\s+citizen/i,
  /\blawful(ly)?\s+(u\.?s\.?\s+)?permanent resident|green card holder/i,
  // UK roles that need British nationality or SC/DV security clearance (years of UK residence), which the candidate cannot get.
  /\b(british|uk)\s+(citizens?|nationals?|nationality)\b[^.]{0,60}\b(only|required|requirement|must)\b|\b(must|required to|need to)\b[^.]{0,40}\b(british|uk)\s+(citizen|national)/i,
  /\b(SC|DV|[Ss]ecurity [Cc]heck)\s*(\(SC\)\s*)?(level\s+)?([Ss]ecurity\s+)?[Cc]learance\b|\b(eligible|able) (for|to obtain|to gain)\b[^.]{0,30}\b(SC|DV)\b(?!\w)/
]
/** The sentence that makes a posting U.S.-person-only, or '' when there is none. */
export function usPersonOnly(text: string): string {
  for (const re of US_PERSON) {
    const m = re.exec(text || '')
    // An employer that applies for export licences, or only might restrict access, still hires others.
    if (m && re === US_PERSON[2]) { const sentence = text.slice(Math.max(0, text.lastIndexOf('.', m.index) + 1), text.indexOf('.', (m.index ?? 0) + m[0].length) + 1 || undefined); if (/licen[cs]e|however|may (be )?(require|need)|if (information|access)/i.test(sentence)) continue }
    if (m) return (text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + m[0].length + 40)).replace(/\s+/g, ' ').trim()
  }
  return ''
}
// ---- Visa sponsorship. In a country where the profile says the candidate needs sponsorship, postings that refuse it are dropped.
export const NEEDS_SPONSOR = { canada: false, usa: false, uk: false }
type SponsorCountry = keyof typeof NEEDS_SPONSOR
const countryOf = (region: string): SponsorCountry | null => (region === 'ontario' || region === 'canada' ? 'canada' : region === 'usa' ? 'usa' : region === 'uk' ? 'uk' : null)
/** Loads the profile's term length and per-country sponsorship answers into the filter. */
export function setRulesFromProfile(p: { termLength?: string; needsSponsorship?: string; sponsorshipUsa?: string; sponsorshipUk?: string }): void {
  setTermFromProfile(p.termLength || '')
  NEEDS_SPONSOR.canada = /^yes$/i.test(p.needsSponsorship || '')
  NEEDS_SPONSOR.usa = /^yes$/i.test(p.sponsorshipUsa || '')
  NEEDS_SPONSOR.uk = /^yes$/i.test(p.sponsorshipUk || '')
}
const SPONSOR_WORD = String.raw`(?:visa|immigration|employment|work|employer|h-?1b|work permit)?\s*sponsor(?:ship|ing|ed)?`
// The bare verb counts only when it is about visas or people ("sponsor visas", "sponsor candidates"), not "sponsor events".
const SPONSOR_VISA = String.raw`(?:visa|immigration|employment|work|employer|h-?1b|work permit)?\s*sponsorship|sponsor(?:ing)?\s+(?:any\s+)?(?:\w+\s+)?(?:visas?|candidates?|applicants?|employment|work|immigration|h-?1b|individuals|international|students?|interns?)\b`
const NO_SPONSOR = [
  // "unable to sponsor", "will not provide visa sponsorship", "does not offer sponsorship"
  new RegExp(String.raw`\b(unable|not able|cannot|can ?not|can't|will not|won't|do not|don't|does not|doesn't|are not able|is not able|not in a position)\b[^.]{0,30}?\b(provide|offer|support|consider|extend|be able to)?\s*(any\s+)?(an?\s+)?(${SPONSOR_VISA})`, 'i'),
  // "sponsorship is not available", "sponsorship will not be provided"
  new RegExp(String.raw`${SPONSOR_WORD}\s+(is|are|will|can)\s+not\s+(be\s+)?(available|provided|offered|considered|supported|possible)`, 'i'),
  // "no visa sponsorship", "not eligible for sponsorship"
  new RegExp(String.raw`\bno\s+${SPONSOR_WORD}|\bnot\s+(eligible|available)\s+for\s+${SPONSOR_WORD}`, 'i'),
  // "must be authorized to work ... without sponsorship", "must not require sponsorship now or in the future"
  new RegExp(String.raw`\bwithout\s+(the\s+need\s+for\s+|requiring\s+|need\s+of\s+)?(current\s+or\s+future\s+|present\s+or\s+future\s+|now\s+or\s+in\s+the\s+future\s+)?(company\s+|employer\s+)?${SPONSOR_WORD}|\b(must|should)\s+not\s+(now\s+or\s+in\s+the\s+future\s+)?(need|require)\b[^.]{0,30}${SPONSOR_WORD}`, 'i')
]
/** The sentence that says a posting will not sponsor a visa, or '' when there is none. */
export function noSponsorship(text: string): string {
  for (const re of NO_SPONSOR) {
    const m = re.exec(text || '')
    if (m) return text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + m[0].length + 30).replace(/\s+/g, ' ').trim()
  }
  return ''
}

/** Rules that need the posting's own text: citizens only, visa sponsorship (when the region is known) and term length. */
export function textProblem(title: string, description: string, region = ''): string {
  if (usPersonOnly(`${title}\n${description}`)) return 'citizens only (U.S. export control, citizenship or clearance, or UK nationality or clearance)'
  const c = countryOf(region)
  if (c && NEEDS_SPONSOR[c] && noSponsorship(description)) return 'does not sponsor work visas'
  return termProblem(title, description)
}

// A US state code after the city ("Burlington, MA", "Vancouver, WA", "London, KY") settles the country, even when
// the city shares its name with a Canadian or British one. ", CA" is left out: it can mean Canada as well as California.
const US_STATE_AFTER_CITY = new RegExp(`,\\s*(${US_STATES.split(' ').filter(s => s !== 'CA').join('|')})\\b`)
const REGION_RANK: (Region | 'unknown')[] = ['ontario', 'canada', 'uk', 'usa', 'other', 'unknown']

/** The region of a location; a list of places ("Toronto, ON; Austin, TX") counts as its most wanted place. */
export function regionOf(location: string): Region | 'unknown' {
  const parts = (location || '').split(/;|\s\/\s|\s\|\s/).map(s => s.trim()).filter(Boolean)
  if (parts.length < 2) return regionOne(location || '')
  return parts.map(regionOne).sort((a, b) => REGION_RANK.indexOf(a) - REGION_RANK.indexOf(b))[0]
}
function regionOne(loc: string): Region | 'unknown' {
  if (US_STATE_AFTER_CITY.test(loc) && !/canada|united kingdom|\bUK\b/i.test(loc)) return 'usa'
  if (ONTARIO.test(loc)) return 'ontario'
  if (CANADA.test(loc)) return 'canada'
  if (UK.test(loc) && !USA.test(loc.replace(UK, ''))) return 'uk'
  if ((ELSEWHERE.test(loc) || ISO3_ELSEWHERE.test(loc)) && !USA.test(loc)) return 'other'
  if (USA.test(loc)) return 'usa'
  return 'unknown'
}

const INTERN = /\b(intern|interns|internship|internships|co-?op|student|summer (20\d\d|term|analyst|associate)|pey|stagiaire|apprentice)\b/i
export const isInternTitle = (title: string): boolean => INTERN.test(title.replace(NOT_INTERN, ''))
const NOT_INTERN = /\b(manager of interns|internal|international)\b/i
const ME_TITLE = /\b(mechanical|mechatronics?|manufacturing|thermal|thermo|fluids?|structures?|structural|propulsion|aerospace|aeronautical|robotics?|hardware|design eng|product design|test eng|materials?|quality eng|process eng|industrial eng|automation|tooling|cad|mechanisms?|vehicle|powertrain|chassis|battery|hvac|reliability|systems eng|production eng|build eng|integration|launch|avionics mech|nuclear|energy|equipment|facilities eng|r&d|research and development|product development|engineering)\b/i
const OFF_TITLE = /\b(software|firmware|data sci|data eng|data analy|machine learning|\bml\b|\bai\b|finance|financial|accounting|marketing|legal|recruit|talent|human resources|\bhr\b|sales|business|supply chain|procurement|communications|design (ux|ui)|ux|ui|graphic|security eng|it support|information technology|cyber|web|cloud|devops|backend|frontend|full.?stack|electrical|electronics|\basic\b|fpga|rf\b|digital design|analog|verification|chemist|biolog|clinical|regulatory|policy|tax|audit|payroll|pilot|nurs|phd|ph\.d|mba)\b/i
const ME_BODY = /\b(mechanical|mechatronics|solidworks|catia|siemens nx|creo|autocad|ansys|gd&t|finite element|fea\b|cfd\b|machining|cnc|3d print|additive manufacturing|dfm|thermodynamics|heat transfer|fluid mechanics)\b/i

export interface FilterVerdict { keep: boolean; region: Region; reason: string }

/** Hard filter that runs before any AI call. needBody = keep is undecided until the description is fetched. */
export function checkJob(j: RawJob): FilterVerdict & { needBody?: boolean } {
  // Vague locations ("3 Locations", "Any SpaceX Site") are common at large employers. Every curated large
  // employer hires in North America, so those are kept and the location is pinned down from the posting later.
  const raw = regionOf(j.location)
  const vague = raw === 'unknown'
  if (raw === 'other' || (vague && !j.big)) return { keep: false, region: 'other', reason: 'outside Canada, the USA and the UK, or location unclear' }
  if (raw === 'uk' && !ukAllowed(j.company)) return { keep: false, region: 'uk', reason: 'UK job at a lesser-known employer' }
  const region: Region = vague ? 'usa' : raw
  if (region !== 'ontario' && !j.big) return { keep: false, region, reason: 'not a large employer outside Ontario' }
  if (region === 'usa' && US_DEFENSE.has(j.company)) return { keep: false, region, reason: 'U.S. defense employer (U.S. persons only)' }
  // A vague location is let through here and settled once the posting itself has been read (see refresh.ts).
  if (raw === 'usa' && !usAllowed(j.company, j.location)) return { keep: false, region, reason: 'lesser-known employer outside California, Texas, Florida and New York City' }
  const title = j.title
  if (!INTERN.test(title.replace(NOT_INTERN, ''))) return { keep: false, region, reason: 'not an internship or co-op' }
  if (/\b(phd|ph\.d\.?|doctoral|mba)\b/i.test(title)) return { keep: false, region, reason: 'graduate-degree role' }
  const mechInTitle = /\b(mechanical|mechatronics?)\b/i.test(title)
  if (!mechInTitle && OFF_TITLE.test(title)) return { keep: false, region, reason: 'different discipline' }
  const tp = termProblem(title, '')
  if (tp) return { keep: false, region, reason: tp }
  // The U.S.-person and term-length rules need the posting text, so a posting without it is always read first.
  if (j.description) { const why = textProblem(title, j.description, region); if (why) return { keep: false, region, reason: why } }
  const needLoc = (vague && j.source === 'workday') || !j.description
  if (mechInTitle) return { keep: true, region, reason: 'mechanical internship', needBody: needLoc || undefined }
  if (!ME_TITLE.test(title)) return { keep: false, region, reason: 'title is not engineering' }
  // Engineering-flavoured title without "mechanical": needs the description to mention ME work.
  if (!j.description) return { keep: true, region, reason: 'needs description check', needBody: true }
  // A LinkedIn alert carries no posting text (LinkedIn is never opened), so an engineering title is enough there.
  if (j.source === 'linkedin') return { keep: true, region, reason: 'engineering internship from a LinkedIn alert' }
  if (POOLED.test(title) && KNOWN.has(j.company)) return { keep: true, region, reason: 'pooled hardware internship at a large employer', needBody: needLoc || undefined }
  return ME_BODY.test(j.description)
    ? { keep: true, region, reason: 'engineering internship that mentions mechanical work', needBody: needLoc || undefined }
    : { keep: false, region, reason: 'description does not mention mechanical work' }
}
