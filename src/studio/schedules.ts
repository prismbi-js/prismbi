import type { DataModel } from '../data/model';
import type { Report, ReportAlert, ReportSubscription } from '../report/report';
import { h } from '../render/svg';
import { openDialog } from './dialogs';

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

/** Edit a report's scheduled sends and measure alerts. */
export function schedulesDialog(host: HTMLElement, model: DataModel, report: Report, onSave: (subs: ReportSubscription[], alerts: ReportAlert[]) => void): void {
  const subs = report.subscriptionList;
  const alerts = report.alertList;
  const subList = h('ul', { class: 'pbs-sched-list', 'aria-label': 'Subscriptions' });
  const alertList = h('ul', { class: 'pbs-sched-list', 'aria-label': 'Alerts' });
  const status = h('div', { class: 'pbs-status', role: 'status' });

  const describeWhen = (a: ReportAlert) => ('above' in a.when ? `above ${a.when.above}` : 'below' in a.when ? `below ${a.when.below}` : `changes by ${Math.round(a.when.changeBy * 100)}%`);
  const render = () => {
    subList.replaceChildren();
    alertList.replaceChildren();
    if (!subs.length) subList.append(h('li', { class: 'pbs-empty' }, 'No scheduled sends yet.'));
    subs.forEach((s, i) => {
      const del = h('button', { type: 'button', class: 'pbs-icon-btn', 'aria-label': `Remove ${s.name}` }, '×');
      del.addEventListener('click', () => (subs.splice(i, 1), render()));
      const page = report.pageList.find((p) => p.id === s.page || p.name === s.page)?.name ?? s.page;
      list(subList, `${s.name}: “${page}” ${typeof s.schedule === 'number' ? `every ${Math.round(s.schedule / 60_000)} min` : s.schedule.replace('daily@', 'daily at ')} → ${s.recipients.join(', ')}`, del);
    });
    if (!alerts.length) alertList.append(h('li', { class: 'pbs-empty' }, 'No alerts yet.'));
    alerts.forEach((a, i) => {
      const del = h('button', { type: 'button', class: 'pbs-icon-btn', 'aria-label': `Remove ${a.name}` }, '×');
      del.addEventListener('click', () => (alerts.splice(i, 1), render()));
      list(alertList, `${a.name}: [${a.measure}] ${describeWhen(a)}${a.recipients?.length ? ` → ${a.recipients.join(', ')}` : ''}`, del);
    });
  };
  const list = (ul: HTMLElement, text: string, btn: HTMLElement) => ul.append(h('li', {}, h('span', {}, text), btn));
  const input = (label: string, value = '', type = 'text') => h('input', { 'aria-label': label, placeholder: label, value, type }) as HTMLInputElement;
  const select = (label: string, options: [string, string][]) => h('select', { 'aria-label': label }, ...options.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
  const lab = (text: string, el: HTMLElement) => h('label', {}, h('span', {}, text), el);
  const emails = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

  // subscription form
  const sName = input('Name', 'Daily summary');
  const sPage = select('Page', report.pageList.filter((p) => !p.hidden).map((p) => [p.id, p.name]));
  const sKind = select('Schedule', [['daily', 'Daily at'], ['every', 'Every (minutes)']]);
  const sTime = input('Time', '08:00', 'time');
  const sTo = input('Recipients (comma separated)');
  const sAdd = h('button', { type: 'button', class: 'pbs-btn' }, 'Add subscription');
  sAdd.addEventListener('click', () => {
    const to = emails(sTo.value);
    if (!to.length) return void (status.textContent = 'Add at least one recipient.');
    const schedule = sKind.value === 'daily' ? `daily@${sTime.value || '08:00'}` : Math.max(1, Number(sTime.value) || 60) * 60_000;
    if (sKind.value === 'daily' && !/^\d{1,2}:\d{2}$/.test(sTime.value)) return void (status.textContent = 'Use a time like 08:00.');
    subs.push({ id: uid('sub'), name: sName.value.trim() || 'Subscription', page: sPage.value, schedule, recipients: to });
    status.textContent = '';
    render();
  });
  sKind.addEventListener('change', () => {
    sTime.type = sKind.value === 'daily' ? 'time' : 'number';
    sTime.value = sKind.value === 'daily' ? '08:00' : '60';
  });

  // alert form
  const measures = model.measureList().filter((m) => !(m as { hidden?: boolean }).hidden).map((m) => m.name);
  const aName = input('Name', 'Sales drop');
  const aMeasure = select('Measure', measures.map((m) => [m, m]));
  const aOp = select('Condition', [['below', 'goes below'], ['above', 'goes above'], ['changeBy', 'changes by (%)']]);
  const aValue = input('Value', '', 'number');
  const aTo = input('Recipients (optional)');
  const aAdd = h('button', { type: 'button', class: 'pbs-btn' }, 'Add alert');
  aAdd.addEventListener('click', () => {
    const v = Number(aValue.value);
    if (!aValue.value || !Number.isFinite(v)) return void (status.textContent = 'Enter a number for the alert.');
    const when = aOp.value === 'above' ? { above: v } : aOp.value === 'below' ? { below: v } : { changeBy: Math.abs(v) / 100 };
    alerts.push({ id: uid('alert'), name: aName.value.trim() || 'Alert', measure: aMeasure.value, when, recipients: emails(aTo.value) });
    status.textContent = '';
    render();
  });

  render();
  const body = h(
    'div',
    { class: 'pbs-sched' },
    h('h4', {}, 'Scheduled sends'),
    subList,
    h('div', { class: 'pbs-step-fields' }, lab('Name', sName), lab('Page', sPage), lab('Schedule', sKind), lab('Time / minutes', sTime), lab('Recipients', sTo), sAdd),
    h('h4', {}, 'Alerts'),
    alertList,
    h('div', { class: 'pbs-step-fields' }, lab('Name', aName), lab('Measure', aMeasure), lab('When it', aOp), lab('Value', aValue), lab('Recipients', aTo), aAdd),
    h('p', { class: 'pbs-note' }, 'Sends run on your server with runSubscriptions(); alerts fire here while editing and anywhere watchAlerts() runs.'),
    status,
  );
  openDialog(host, 'Schedules & alerts', body, [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => onSave(subs, alerts) }]);
}
