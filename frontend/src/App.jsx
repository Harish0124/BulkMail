import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  History,
  LoaderCircle,
  Mail,
  Plus,
  Send,
  Upload,
  UsersRound,
} from 'lucide-react'
import './App.css'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const maxRecipients = 100
const maxUploadSize = 5 * 1024 * 1024
const maxWords = 30
const apiBaseUrl = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? '' : 'https://bulkmail-mpsk.onrender.com')).replace(/\/+$/, '')

function countWords(value) {
  return value.trim() ? value.trim().split(/\s+/).length : 0
}

function findEmails(value) {
  return String(value ?? '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
}

async function readApiResponse(response) {
  if (response.status === 404) {
    const endpoint = new URL(response.url).pathname
    throw new Error(`API endpoint not found (404): ${endpoint}. Check that the Express backend is running on port 5000 and restart the Vite server so its /api proxy is active.`)
  }

  const responseText = await response.text()
  if (!responseText.trim()) {
    throw new Error(`The server returned an empty response (HTTP ${response.status}). Check the backend logs for this request.`)
  }

  try {
    return JSON.parse(responseText)
  } catch {
    throw new Error(`The server returned an invalid response (HTTP ${response.status}). Check the backend logs.`)
  }
}

function splitRecipients(value) {
  return [...new Map(value.split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => [email.toLowerCase(), email])).values()]
}

async function getCampaigns() {
  try {
    const response = await fetch(`${apiBaseUrl}/api/campaigns`)
    const result = await readApiResponse(response)
    return response.ok ? result.campaigns : []
  } catch {
    return []
  }
}

function formatDate(value) {
  if (!value) return 'Just now'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function App() {
  const [view, setView] = useState('compose')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [recipientText, setRecipientText] = useState('')
  const [campaigns, setCampaigns] = useState([])
  const [sending, setSending] = useState(false)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [apiStatus, setApiStatus] = useState('checking')
  const [databaseReady, setDatabaseReady] = useState(false)
  const [mailConfigured, setMailConfigured] = useState(false)
  const fileInputRef = useRef(null)
  const recipients = splitRecipients(recipientText)
  const invalidCount = recipients.filter((email) => !emailPattern.test(email)).length

  async function refreshHistory() {
    if (!databaseReady) {
      setCampaigns([])
      return
    }
    setCampaigns(await getCampaigns())
  }

  useEffect(() => {
    async function initialize() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/health`)
        const result = await readApiResponse(response)
        setApiStatus(response.ok ? 'connected' : 'offline')
        setDatabaseReady(Boolean(result.database))
        setMailConfigured(Boolean(result.mailConfigured))
        setCampaigns(result.database ? await getCampaigns() : [])
      } catch {
        setApiStatus('offline')
      }
    }

    initialize()
  }, [])

  async function importRecipients(file) {
    if (!file) return
    setNotice(null)
    setImporting(true)
    try {
      if (file.size > maxUploadSize) throw new Error('Choose a file smaller than 5 MB.')

      let imported = []
      if (file.name.toLowerCase().endsWith('.csv')) {
        const papaModule = await import('papaparse')
        const Papa = papaModule.default ?? papaModule
        const parsed = Papa.parse(await file.text(), { skipEmptyLines: true })
        if (parsed.errors.length) throw new Error('The CSV file could not be read.')
        imported = parsed.data.flatMap((row) => row.flatMap(findEmails))
      } else if (file.name.toLowerCase().endsWith('.xlsx')) {
        const excelModule = await import('exceljs')
        const Workbook = excelModule.Workbook ?? excelModule.default.Workbook
        const workbook = new Workbook()
        await workbook.xlsx.load(await file.arrayBuffer())
        const worksheet = workbook.worksheets[0]
        if (!worksheet) throw new Error('The file does not contain a worksheet.')
        worksheet.eachRow({ includeEmpty: false }, (row) => {
          row.eachCell({ includeEmpty: false }, (cell) => imported.push(...findEmails(cell.text ?? cell.value)))
        })
      } else {
        throw new Error('Choose a CSV or .xlsx file.')
      }

      if (imported.length === 0) throw new Error('No email addresses were found in that file.')

      setRecipientText((current) =>
        [...new Set([...splitRecipients(current), ...imported])].join('\n'),
      )
      setNotice({ type: 'success', text: `Imported ${imported.length} email address${imported.length === 1 ? '' : 'es'}.` })
    } catch (error) {
      setNotice({ type: 'error', text: error.message || 'Could not read that file.' })
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setNotice(null)

    if (recipients.length === 0) {
      setNotice({ type: 'error', text: 'Add at least one recipient email address.' })
      return
    }
    if (recipients.length > maxRecipients) {
      setNotice({ type: 'error', text: `You can send to up to ${maxRecipients} recipients at a time.` })
      return
    }
    if (invalidCount > 0) {
      setNotice({ type: 'error', text: 'Fix or remove the invalid email addresses before sending.' })
      return
    }

    setSending(true)
    try {
      const response = await fetch(`${apiBaseUrl}/api/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body, recipients }),
      })
      const result = await readApiResponse(response)
      if (!response.ok) throw new Error(result.message || 'The campaign could not be sent.')

      if (result.status === 'partial') {
        const failedRecipients = result.deliveryResults
          .filter((delivery) => delivery.status === 'failed')
          .map((delivery) => delivery.email)
        setNotice({ type: 'error', text: `${result.message} Failed recipients are left in the list for retry.` })
        setRecipientText(failedRecipients.join('\n'))
      } else {
        setNotice({ type: 'success', text: result.message })
        setSubject('')
        setBody('')
        setRecipientText('')
      }
      await refreshHistory()
    } catch (error) {
      setNotice({ type: 'error', text: error.message || 'Could not reach the mail server.' })
      await refreshHistory()
    } finally {
      setSending(false)
    }
  }

  const serviceLabel = apiStatus === 'connected' ? 'API connected' : apiStatus === 'checking' ? 'Checking API' : 'API offline'

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#compose" onClick={() => setView('compose')}>
          <span className="brand-mark"><Mail size={19} strokeWidth={2.2} /></span>
          <span className="brand-name">postbird<span>.</span></span>
        </a>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button className={view === 'compose' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('compose'); setNotice(null) }}>
            <Plus size={17} /> <span>New campaign</span>
          </button>
          <button className={view === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('history'); setNotice(null); refreshHistory() }}>
            <History size={17} /> <span>Sent history</span>
            {campaigns.length > 0 && <span className="nav-count">{campaigns.length}</span>}
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-rule" />
          <div className="sender-label">SENDER STATUS</div>
          <div className="service-line"><span className={`status-dot ${apiStatus}`} />{serviceLabel}</div>
          <div className="service-line"><span className={`status-dot ${databaseReady ? 'ready' : 'waiting'}`} />MongoDB {databaseReady ? 'connected' : 'not connected'}</div>
          <div className="service-line"><span className={`status-dot ${mailConfigured ? 'ready' : 'waiting'}`} />SMTP {mailConfigured ? 'configured' : 'not configured'}</div>
          <p className="sidebar-footnote">Each recipient gets a private message.</p>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-divider">/</span><strong>{view === 'compose' ? 'New campaign' : 'Sent history'}</strong></div>
          <div className={`api-indicator ${apiStatus}`}><span className="status-dot" />{serviceLabel}</div>
        </header>

        {view === 'compose' ? (
          <section className="page-content compose-page">
            <div className="page-heading">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" />CAMPAIGN STUDIO</div>
                <h1>Write once.<br /><em>Reach everyone.</em></h1>
                <p className="page-description">Put together your message and send it to your list.</p>
              </div>
              <div className="heading-metric"><span className="metric-icon"><UsersRound size={18} /></span><span><strong>{recipients.length}</strong><small>recipient{recipients.length === 1 ? '' : 's'} added</small></span></div>
            </div>

            <div className="compose-layout">
              <form className="compose-form" onSubmit={handleSubmit}>
                <div className="form-topline"><div><span className="step-number">01</span><h2>Campaign details</h2></div><span className="required-note">All fields required</span></div>

                <label className="field-label" htmlFor="subject">Subject line <span>Required</span></label>
                <input id="subject" className="text-input" type="text" maxLength={200} placeholder="A clear subject your readers will open" value={subject} onChange={(event) => setSubject(event.target.value)} required />
                <div className="input-meta"><span>Keep it clear and specific</span><span>{subject.length}/200</span></div>

                <div className="recipient-heading">
                  <label className="field-label" htmlFor="recipients">Recipients <span>Required</span></label>
                  <span className={`recipient-count ${recipients.length > maxRecipients || invalidCount ? 'count-warning' : ''}`}>{recipients.length} / {maxRecipients}</span>
                </div>
                <textarea id="recipients" className="text-input recipient-input" placeholder={'alex@example.com\njamie@example.com'} value={recipientText} onChange={(event) => setRecipientText(event.target.value)} required aria-describedby="recipient-help" />
                <div className="input-meta" id="recipient-help">
                  <span>{invalidCount ? `${invalidCount} invalid address${invalidCount === 1 ? '' : 'es'}` : 'Separate addresses with commas or new lines'}</span>
                  <span className="privacy-note"><Check size={13} /> Addresses stay private</span>
                </div>

                <label className="field-label body-label" htmlFor="message">Email message <span>Required</span></label>
                <textarea id="message" className="text-input message-input" placeholder="Write your message here..." maxLength={20000} value={body} onChange={(event) => {
                  const nextBody = event.target.value
                  if (countWords(nextBody) <= maxWords) setBody(nextBody)
                  else setBody(nextBody.trim().split(/\s+/).slice(0, maxWords).join(' '))
                }} required />
                <div className="input-meta"><span>Plain text · 30 words maximum</span><span>{countWords(body)}/{maxWords} words</span></div>

                {notice && <div className={`notice ${notice.type}`} role="status">{notice.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}<span>{notice.text}</span></div>}

                <div className="form-footer">
                  <span className="delivery-note"><Clock3 size={15} /> Sends immediately</span>
                  <button className="send-button" type="submit" disabled={sending || importing}>
                    {sending ? <LoaderCircle className="spin" size={17} /> : <Send size={16} />}
                    {sending ? 'Sending campaign' : 'Send campaign'}
                    {!sending && <ArrowUpRight size={15} />}
                  </button>
                </div>
              </form>

              <aside className="compose-aside">
                <div className="aside-section import-section">
                  <div className="aside-heading"><span className="aside-icon"><FileSpreadsheet size={17} /></span><h3>Import a list</h3></div>
                  <p>Bring in addresses from a spreadsheet. Duplicate emails are skipped.</p>
                  <button className="upload-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={importing}>
                    {importing ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
                    {importing ? 'Reading file...' : 'Choose a file'}
                  </button>
                  <input ref={fileInputRef} className="visually-hidden" type="file" accept=".csv,.xlsx" onChange={(event) => importRecipients(event.target.files?.[0])} />
                  <span className="file-types">CSV or .xlsx · max 5 MB</span>
                </div>

                <div className="aside-section delivery-section">
                  <div className="aside-heading"><span className="aside-icon green"><Mail size={17} /></span><h3>Delivery</h3></div>
                  <div className="delivery-row"><span>Recipient limit</span><strong>{maxRecipients} per campaign</strong></div>
                  <div className="delivery-row"><span>Address privacy</span><strong><Check size={13} /> One private email each</strong></div>
                  <div className="delivery-row"><span>Message format</span><strong>Plain text</strong></div>
                </div>

                <button className="history-link" type="button" onClick={() => { setView('history'); refreshHistory() }}><span><History size={16} /> View sent history</span><ArrowUpRight size={15} /></button>
                <p className="history-caption">Previous campaigns are saved to your database.</p>
              </aside>
            </div>
          </section>
        ) : (
          <section className="page-content history-page">
            <div className="page-heading history-heading">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" />CAMPAIGN ARCHIVE</div>
                <h1>Sent <em>history.</em></h1>
                <p className="page-description">A record of campaigns sent from this workspace.</p>
              </div>
              <button className="new-campaign-button" type="button" onClick={() => { setView('compose'); setNotice(null) }}><Plus size={16} /> New campaign</button>
            </div>

            <div className="history-toolbar"><div><History size={16} /><strong>Recent campaigns</strong><span>{campaigns.length}</span></div><button type="button" onClick={refreshHistory}>Refresh</button></div>
            {campaigns.length ? (
              <div className="campaign-list">
                {campaigns.map((campaign) => (
                  <article className="campaign-row" key={campaign._id}>
                    <div className={`campaign-status ${campaign.status}`}>{campaign.status === 'sent' ? <CheckCircle2 size={17} /> : campaign.status === 'failed' ? <AlertCircle size={17} /> : <Clock3 size={17} />}</div>
                    <div className="campaign-main"><div className="campaign-title-row"><h2>{campaign.subject}</h2><span className={`status-label ${campaign.status}`}>{campaign.status}</span></div><p>{campaign.body}</p><div className="campaign-recipients"><UsersRound size={14} /><span>{campaign.recipients.slice(0, 2).join(', ')}{campaign.recipients.length > 2 ? ` +${campaign.recipients.length - 2} more` : ''}</span></div></div>
                    <time className="campaign-date" dateTime={campaign.createdAt}>{formatDate(campaign.sentAt || campaign.createdAt)}</time>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state"><span className="empty-icon"><Mail size={24} /></span><h2>{databaseReady ? 'No campaigns yet' : 'History unavailable'}</h2><p>{databaseReady ? 'Once you send a campaign, it will appear here.' : 'Connect the API and MongoDB to load saved campaigns.'}</p><button className="new-campaign-button" type="button" onClick={() => setView('compose')}><Plus size={16} /> Compose a campaign</button></div>
            )}
          </section>
        )}

        <footer className="app-footer"><span>POSTBIRD <span className="footer-dot">/</span> BULK MAIL</span><span>Simple, considerate email delivery.</span></footer>
      </main>
    </div>
  )
}

export default App
