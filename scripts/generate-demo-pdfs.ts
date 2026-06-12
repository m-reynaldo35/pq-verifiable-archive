import PDFDocument from 'pdfkit';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';

interface DocSpec {
  filename: string;
  title: string;
  parties: [string, string];
  clauses: { heading: string; body: string }[];
}

const docs: DocSpec[] = [
  {
    filename: 'non-disclosure-agreement.pdf',
    title: 'NON-DISCLOSURE AGREEMENT',
    parties: ['Nexus Ventures Ltd', 'Brightfield Analytics Inc'],
    clauses: [
      {
        heading: '1. Definition of Confidential Information',
        body: 'For purposes of this Agreement, "Confidential Information" means any data or information that is proprietary to the Disclosing Party and not generally known to the public, whether in tangible or intangible form, including but not limited to technical data, trade secrets, research, product plans, products, services, customers, markets, software, developments, and inventions.',
      },
      {
        heading: '2. Obligations of Receiving Party',
        body: 'The Receiving Party agrees to hold the Confidential Information in strict confidence, to not disclose it to any third party without prior written consent of the Disclosing Party, and to use the Confidential Information solely for the purpose of evaluating a potential business relationship between the parties.',
      },
      {
        heading: '3. Term',
        body: 'This Agreement shall remain in effect for a period of three (3) years from the Effective Date. The obligations of confidentiality shall survive the termination or expiration of this Agreement.',
      },
      {
        heading: '4. Governing Law',
        body: 'This Agreement shall be governed by and construed in accordance with the laws of England and Wales, without regard to conflicts of law principles.',
      },
    ],
  },
  {
    filename: 'employment-contract.pdf',
    title: 'EMPLOYMENT CONTRACT',
    parties: ['Meridian Group PLC', 'Jordan K. Whitfield'],
    clauses: [
      {
        heading: '1. Position and Duties',
        body: 'The Employee is engaged as Senior Software Engineer and shall perform such duties as are customarily associated with such position, including but not limited to designing, developing, and maintaining software systems, and such other duties as may be reasonably assigned by the Employer from time to time.',
      },
      {
        heading: '2. Compensation',
        body: 'The Employer shall pay the Employee an annual base salary of £85,000, payable in equal monthly instalments on the last business day of each calendar month. The Employee shall be eligible for an annual performance bonus at the Employer\'s discretion.',
      },
      {
        heading: '3. Intellectual Property',
        body: 'All work product, inventions, and developments created by the Employee in the course of employment shall be the sole and exclusive property of the Employer. The Employee hereby assigns to the Employer all right, title, and interest in and to such work product.',
      },
      {
        heading: '4. Termination',
        body: 'Either party may terminate this Agreement by providing three (3) months written notice to the other party. The Employer reserves the right to pay salary in lieu of notice. Summary dismissal may occur in cases of gross misconduct.',
      },
    ],
  },
  {
    filename: 'software-license-agreement.pdf',
    title: 'SOFTWARE LICENSE AGREEMENT',
    parties: ['Orbital Systems Ltd', 'Cascade Financial Services Ltd'],
    clauses: [
      {
        heading: '1. Grant of License',
        body: 'Orbital Systems Ltd ("Licensor") hereby grants to Cascade Financial Services Ltd ("Licensee") a non-exclusive, non-transferable, limited license to install and use the Licensor\'s proprietary software platform ("Software") solely for the Licensee\'s internal business operations, for the term set out herein.',
      },
      {
        heading: '2. Restrictions',
        body: 'The Licensee shall not copy, modify, translate, adapt, or create derivative works of the Software; reverse engineer, disassemble, or decompile the Software; sublicense, sell, resell, transfer, or otherwise make the Software available to any third party; or remove any proprietary notices or labels on the Software.',
      },
      {
        heading: '3. Fees and Payment',
        body: 'The Licensee shall pay the annual license fee of £24,000 in advance on the commencement date of each year of the license term. All fees are exclusive of VAT. Late payments shall accrue interest at 4% above the Bank of England base rate.',
      },
      {
        heading: '4. Limitation of Liability',
        body: 'In no event shall the Licensor be liable for any indirect, incidental, special, consequential, or punitive damages. The Licensor\'s total cumulative liability shall not exceed the fees paid by the Licensee in the twelve months preceding the claim.',
      },
    ],
  },
  {
    filename: 'partnership-agreement.pdf',
    title: 'PARTNERSHIP AGREEMENT',
    parties: ['Thornwood Capital Partners LLP', 'Elara Property Group Ltd'],
    clauses: [
      {
        heading: '1. Formation and Purpose',
        body: 'The parties hereby agree to form a limited partnership for the purpose of acquiring, developing, managing, and disposing of real estate assets in the United Kingdom. The partnership shall operate under the name "Thornwood Elara Real Estate LP" and shall be registered in accordance with the Limited Partnerships Act 1907.',
      },
      {
        heading: '2. Capital Contributions',
        body: 'Thornwood Capital Partners LLP shall contribute £5,000,000 representing 60% of the initial capital. Elara Property Group Ltd shall contribute £3,333,333 representing 40% of the initial capital. Additional capital contributions may be made by mutual written agreement of the partners.',
      },
      {
        heading: '3. Profit and Loss Distribution',
        body: 'Net profits and losses of the partnership shall be allocated to the partners in proportion to their respective capital contributions, being 60% to Thornwood Capital Partners LLP and 40% to Elara Property Group Ltd, unless otherwise agreed in writing.',
      },
      {
        heading: '4. Dissolution',
        body: 'The partnership shall be dissolved upon unanimous written agreement of all partners, or upon the occurrence of an event making it unlawful for the partnership business to be continued. On dissolution, assets shall be liquidated and proceeds distributed in accordance with capital contribution percentages.',
      },
    ],
  },
  {
    filename: 'consulting-services-agreement.pdf',
    title: 'CONSULTING SERVICES AGREEMENT',
    parties: ['Vantage Advisory Ltd', 'Stratford Manufacturing PLC'],
    clauses: [
      {
        heading: '1. Scope of Services',
        body: 'Vantage Advisory Ltd ("Consultant") agrees to provide strategic operational consulting services to Stratford Manufacturing PLC ("Client"), including process optimisation analysis, supply chain review, and implementation roadmap development, as further detailed in Schedule A attached hereto and incorporated by reference.',
      },
      {
        heading: '2. Fees and Expenses',
        body: 'The Client shall pay the Consultant a monthly retainer of £12,500, invoiced on the first business day of each month, payable within 30 days of invoice date. Pre-approved expenses shall be reimbursed within 14 days of submission. The Consultant shall provide monthly expense reports with supporting documentation.',
      },
      {
        heading: '3. Independent Contractor',
        body: 'The Consultant is an independent contractor and not an employee, agent, or partner of the Client. The Consultant shall have full control over the manner and means of providing the Services, subject to meeting agreed deliverables and timelines. The Consultant is solely responsible for all taxes on its compensation.',
      },
      {
        heading: '4. Confidentiality and Non-Solicitation',
        body: 'The Consultant shall maintain the confidentiality of all Client information for a period of two (2) years following termination. During the term and for twelve (12) months thereafter, the Consultant shall not solicit or employ any employee or contractor of the Client.',
      },
    ],
  },
  {
    filename: 'data-processing-agreement.pdf',
    title: 'DATA PROCESSING AGREEMENT',
    parties: ['CloudBase Technologies Ltd', 'Apex Retail Group PLC'],
    clauses: [
      {
        heading: '1. Definitions and Scope',
        body: 'This Data Processing Agreement ("DPA") governs the processing of personal data by CloudBase Technologies Ltd ("Processor") on behalf of Apex Retail Group PLC ("Controller") in connection with the cloud infrastructure services provided under the Master Services Agreement dated on the Effective Date. Terms used herein shall have the meanings given in the UK General Data Protection Regulation and the Data Protection Act 2018.',
      },
      {
        heading: '2. Processor Obligations',
        body: 'The Processor shall: (a) process personal data only on documented instructions from the Controller; (b) ensure persons authorised to process personal data are subject to obligations of confidentiality; (c) implement appropriate technical and organisational measures to ensure a level of security appropriate to the risk; and (d) not engage sub-processors without prior written authorisation from the Controller.',
      },
      {
        heading: '3. Data Subject Rights',
        body: 'The Processor shall assist the Controller, by appropriate technical and organisational measures, in fulfilling the Controller\'s obligations to respond to requests for exercising data subjects\' rights under Chapter III of the UK GDPR, including rights of access, rectification, erasure, restriction, portability, and objection. The Processor shall notify the Controller within 48 hours of receiving any such request.',
      },
      {
        heading: '4. Data Breach Notification',
        body: 'In the event of a personal data breach, the Processor shall notify the Controller without undue delay and in any event within 24 hours of becoming aware of the breach. Such notification shall include the nature of the breach, categories and approximate numbers of data subjects and records concerned, and measures taken or proposed to address the breach.',
      },
    ],
  },
  {
    filename: 'share-purchase-agreement.pdf',
    title: 'SHARE PURCHASE AGREEMENT',
    parties: ['Harlow Capital Partners Ltd', 'Greenfield Biotech Ltd'],
    clauses: [
      {
        heading: '1. Sale and Purchase',
        body: 'Subject to the terms and conditions of this Agreement, the Seller agrees to sell, and the Buyer agrees to purchase, 100% of the issued share capital of Greenfield Biotech Ltd ("the Company"), comprising 10,000,000 ordinary shares of £0.01 each ("the Shares"), free from all encumbrances and together with all rights attaching thereto as at Completion.',
      },
      {
        heading: '2. Consideration',
        body: 'The aggregate consideration for the Shares shall be £12,500,000 ("the Purchase Price"), to be paid as follows: (a) £10,000,000 in cash on Completion; (b) £1,500,000 deferred for 12 months subject to the Company achieving EBITDA of not less than £2,000,000 in the first full financial year post-Completion; and (c) £1,000,000 released upon grant of the pending patent applications listed in Schedule 2.',
      },
      {
        heading: '3. Completion',
        body: 'Completion shall take place at the offices of the Buyer\'s solicitors on the date falling five (5) Business Days after satisfaction or waiver of all Conditions Precedent set out in Schedule 1. At Completion, the Seller shall deliver to the Buyer stock transfer forms, original share certificates, and all corporate records of the Company.',
      },
      {
        heading: '4. Warranties and Indemnities',
        body: 'The Seller gives the Warranties set out in Schedule 3 as at the date of this Agreement and as at Completion. Any claim under the Warranties must be brought within 24 months of Completion, save for Tax Warranties which must be brought within seven years. The Seller\'s aggregate liability for Warranty claims shall not exceed the Purchase Price.',
      },
    ],
  },
  {
    filename: 'commercial-lease-agreement.pdf',
    title: 'COMMERCIAL LEASE AGREEMENT',
    parties: ['Westbrook Property Investments Ltd', 'Horizon Digital Studio Ltd'],
    clauses: [
      {
        heading: '1. Demise and Term',
        body: 'The Landlord demises to the Tenant the premises known as Suite 4A, 22 Canary Wharf, London E14 5AB ("the Premises"), comprising approximately 3,200 square feet of net lettable area, for a term of five (5) years commencing on the Completion Date, with an option to renew for a further term of five years on the same terms save as to rent.',
      },
      {
        heading: '2. Rent and Review',
        body: 'The Tenant shall pay to the Landlord an annual rent of £128,000, payable quarterly in advance on the usual quarter days. The rent shall be reviewed upwards only on the third anniversary of the Completion Date to the higher of the passing rent and the open market rent as determined by a chartered surveyor in accordance with the RICS Valuation Standards.',
      },
      {
        heading: '3. Permitted Use',
        body: 'The Tenant shall use the Premises solely for the purpose of a creative digital studio, software development office, and ancillary uses within Class E of the Town and Country Planning (Use Classes) Order 1987 (as amended). The Tenant shall not use the Premises for any purpose that would cause nuisance or annoyance to the Landlord or neighbouring tenants.',
      },
      {
        heading: '4. Repairing Obligations',
        body: 'The Tenant shall keep and maintain the interior of the Premises, including all fixtures and fittings, in good and substantial repair and condition throughout the Term and shall yield up the Premises at the end of the Term in such repair and condition, fair wear and tear excepted. The Landlord is responsible for the exterior, structure, and common parts of the building.',
      },
    ],
  },
  {
    filename: 'intellectual-property-assignment.pdf',
    title: 'INTELLECTUAL PROPERTY ASSIGNMENT AGREEMENT',
    parties: ['Solara Labs Ltd', 'Pemberton Industries PLC'],
    clauses: [
      {
        heading: '1. Assignment of IP Rights',
        body: 'In consideration of the payment set out in Clause 2, the Assignor hereby assigns to the Assignee absolutely, with full title guarantee, all intellectual property rights (including patents, trade marks, copyright, design rights, database rights, and all applications therefor) in and relating to the proprietary machine learning framework known as "NeuralCore v3" and all associated documentation, source code, and training datasets ("the IP").',
      },
      {
        heading: '2. Consideration',
        body: 'In consideration of the assignment of the IP Rights, the Assignee shall pay to the Assignor the sum of £2,750,000, payable as follows: £1,500,000 on execution of this Agreement, and £1,250,000 on successful registration of the principal patent (GB2504123.7) in the name of the Assignee. All payments are inclusive of VAT at the applicable rate.',
      },
      {
        heading: '3. Warranties',
        body: 'The Assignor warrants that it is the sole legal and beneficial owner of the IP Rights; the IP does not infringe the intellectual property rights of any third party; there are no pending claims, disputes, or litigation concerning the IP; and the Assignor has not granted any licence or other right in respect of the IP to any third party.',
      },
      {
        heading: '4. Further Assurance',
        body: 'The Assignor shall, at the Assignee\'s reasonable cost and expense, execute all documents and do all such things as the Assignee may reasonably require to vest the IP Rights in the Assignee and to register the Assignee as proprietor of any registered IP Rights included in the assignment.',
      },
    ],
  },
  {
    filename: 'service-level-agreement.pdf',
    title: 'SERVICE LEVEL AGREEMENT',
    parties: ['Nexgen Infrastructure Ltd', 'Broadstone Financial Services Ltd'],
    clauses: [
      {
        heading: '1. Service Availability',
        body: 'Nexgen Infrastructure Ltd ("Provider") shall make the managed cloud platform ("Service") available to Broadstone Financial Services Ltd ("Customer") with a minimum monthly uptime of 99.95% measured on a rolling 30-day basis, excluding Scheduled Maintenance Windows communicated at least 72 hours in advance. Uptime is defined as the percentage of time the Service is accessible and operational during normal operating conditions.',
      },
      {
        heading: '2. Performance Standards',
        body: 'The Provider shall ensure that: (a) API response time for standard requests shall not exceed 200ms at the 95th percentile; (b) data ingestion pipelines shall process batches within 4 hours of receipt under normal load; (c) recovery time objective (RTO) for Tier 1 services shall not exceed 1 hour; and (d) recovery point objective (RPO) shall not exceed 15 minutes for all production databases.',
      },
      {
        heading: '3. Service Credits',
        body: 'In the event of a breach of the availability commitment, the Customer shall be entitled to a service credit as follows: below 99.95% but above 99.0% — 10% of the Monthly Service Fee; below 99.0% but above 95.0% — 25%; below 95.0% — 50%. Service credits shall be applied against the following month\'s invoice and shall constitute the Customer\'s sole and exclusive remedy for availability failures.',
      },
      {
        heading: '4. Support and Incident Response',
        body: 'The Provider shall maintain a 24/7 technical support function. Critical incidents (P1) affecting core payment processing shall receive an initial response within 15 minutes and a resolution target of 4 hours. High-priority incidents (P2) shall receive response within 1 hour and resolution target of 8 hours. All incidents shall be tracked and reported in monthly service review meetings.',
      },
    ],
  },
];

function generatePdf(spec: DocSpec, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72, size: 'A4' });
    const stream = createWriteStream(outputPath);
    doc.pipe(stream);

    const pageWidth = doc.page.width - 144;
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text(spec.title, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').fillColor('#666666').text(`Dated: ${today}`, { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(1.5);

    // Parties
    doc.fontSize(11).font('Helvetica-Bold').text('PARTIES');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');
    doc.text(`This Agreement is entered into between:`);
    doc.moveDown(0.3);
    doc.text(`(1)  ${spec.parties[0]} ("Party A"); and`);
    doc.moveDown(0.2);
    doc.text(`(2)  ${spec.parties[1]} ("Party B").`);
    doc.moveDown(1.5);

    // Clauses
    for (const clause of spec.clauses) {
      doc.fontSize(11).font('Helvetica-Bold').text(clause.heading);
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').text(clause.body, { width: pageWidth, align: 'justify' });
      doc.moveDown(1.2);
    }

    // Signature blocks
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').text('EXECUTED AS AN AGREEMENT');
    doc.moveDown(1);

    const colWidth = pageWidth / 2 - 20;
    const startY = doc.y;

    // Party A
    doc.fontSize(10).font('Helvetica-Bold').text('Signed for and on behalf of', 72, startY, { width: colWidth });
    doc.font('Helvetica').text(spec.parties[0], 72, doc.y, { width: colWidth });
    doc.moveDown(2.5);
    doc.moveTo(72, doc.y).lineTo(72 + colWidth, doc.y).stroke();
    doc.moveDown(0.3);
    doc.text('Authorised Signatory', 72, doc.y, { width: colWidth });
    doc.moveDown(0.2);
    doc.text('Name: _______________________', 72, doc.y, { width: colWidth });
    doc.moveDown(0.2);
    doc.text('Date:  _______________________', 72, doc.y, { width: colWidth });

    // Party B
    const rightCol = 72 + colWidth + 40;
    doc.fontSize(10).font('Helvetica-Bold').text('Signed for and on behalf of', rightCol, startY, { width: colWidth });
    doc.font('Helvetica').text(spec.parties[1], rightCol, startY + 14, { width: colWidth });
    doc.moveDown(0);
    const sigY = startY + 80;
    doc.moveTo(rightCol, sigY).lineTo(rightCol + colWidth, sigY).stroke();
    doc.text('Authorised Signatory', rightCol, sigY + 6, { width: colWidth });
    doc.text('Name: _______________________', rightCol, sigY + 20, { width: colWidth });
    doc.text('Date:  _______________________', rightCol, sigY + 34, { width: colWidth });

    // Footer
    doc.fontSize(8).fillColor('#888888')
      .text('CONFIDENTIAL — FOR DEMONSTRATION PURPOSES ONLY', 72, doc.page.height - 50, {
        align: 'center', width: pageWidth,
      });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function main() {
  await mkdir('assets/demo-contracts', { recursive: true });
  for (const spec of docs) {
    const path = `assets/demo-contracts/${spec.filename}`;
    await generatePdf(spec, path);
    console.log(`Generated: ${path}`);
  }
  console.log(`Done — ${docs.length} demo PDFs written to assets/demo-contracts/`);
}

main().catch(e => { console.error(e); process.exit(1); });
