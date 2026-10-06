import type { Metadata } from "next";
import { getBrand } from "@/config/brand";
import { RETENTION } from "@/config/privacy";
import { LegalPage } from "@/components/landing/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Notice",
  description: "How we collect, use and share your personal information when you ask for electrician quotes.",
};

export default function PrivacyPage() {
  const brand = getBrand();
  return (
    <LegalPage title="Privacy Notice">
      <p>
        This notice explains what personal information {brand.name} collects when you ask for electrician quotes, why we collect it,
        who we share it with and what your rights are.
      </p>

      <h2>Who we are</h2>
      <p>
        {brand.legalName} (&ldquo;{brand.name}&rdquo;, &ldquo;we&rdquo;) is the controller of your personal information. Company
        number {brand.companyNumber}; registered office {brand.registeredAddress}. ICO registration number{" "}
        {brand.icoRegistration}. Contact us about privacy at <a href={`mailto:${brand.privacyEmail}`}>{brand.privacyEmail}</a>.
      </p>
      <p>
        We are an introduction service: we are not an electrical company. We pass your enquiry to an electrical business, and that
        business then decides how to use your details to contact you and give you a quote.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>What you tell us:</strong> your postcode, the type of property, your connection to it, the electrical work you need,
          when you want it done, your name, phone number, email address and anything you choose to add in the optional notes box.
        </li>
        <li>
          <strong>Your agreement:</strong> a record of exactly what you agreed to (the wording and version), when, and the web page,
          IP address and browser details at that moment, so we can show that you agreed.
        </li>
        <li>
          <strong>Technical and marketing information:</strong> your IP address, browser and device type, the website or advert that
          brought you here (for example the campaign details in the link you clicked), and the date and time.
        </li>
        <li>
          <strong>Spam checks:</strong> signals such as how quickly the form was completed and how often the same details or network
          address were used. We use Cloudflare Turnstile to tell people from automated programs.
        </li>
      </ul>

      <h2>Why we use it, and our legal basis</h2>
      <ul>
        <li>
          <strong>To find an electrical business for your enquiry, pass your details to it and let it contact you:</strong> your
          consent, which you give by ticking the box on the form.
        </li>
        <li>
          <strong>To prevent spam and fraud and keep our service secure:</strong> our legitimate interests in protecting our service
          and the businesses and people who use it.
        </li>
        <li>
          <strong>To keep records of your consent and to deal with complaints or legal claims:</strong> our legitimate interests and
          our legal obligations.
        </li>
        <li>
          <strong>To understand which adverts work, using summarised figures:</strong> our legitimate interests in running and
          improving our business.
        </li>
      </ul>

      <h2>Who we share your details with</h2>
      <ul>
        <li>
          <strong>One local electrical business</strong> that covers your area. It receives the details you entered and uses them to
          contact you about your enquiry, by phone, text message, WhatsApp or email. Once it has your details it is responsible, as
          a separate controller, for how it uses them and must give you its own privacy information.
        </li>
        <li>
          <strong>Service providers</strong> that process information on our behalf, such as hosting, database, spam-protection and
          messaging providers. They may only use it to provide their service to us.
        </li>
        <li>
          <strong>Authorities and advisers</strong> where the law requires it or where we need advice to protect our rights.
        </li>
      </ul>
      <p>We do not sell your details to anyone else and we do not add you to marketing lists.</p>

      <h2>Automated screening</h2>
      <p>
        Our spam checks produce a score. A high score can mean an enquiry is held back for a person to review or is not passed on.
        If you think your enquiry was wrongly stopped, email us and we will review it.
      </p>

      <h2>Transfers outside the UK</h2>
      <p>
        Some of our providers may process information outside the UK. Where they do, we make sure it is protected, for example
        through a UK adequacy decision or the UK International Data Transfer Agreement or Addendum.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Contact details of enquiries passed on or still being processed: {RETENTION.leadContactMonths} months.</li>
        <li>Contact details of enquiries we rejected as spam or recognised as repeats: {RETENTION.rejectedLeadContactDays} days.</li>
        <li>
          Network addresses and spam-check signals held against an enquiry: {RETENTION.fraudSignalDays} days.
        </li>
        <li>
          Proof of what you agreed to and when: up to {RETENTION.consentEvidenceYears} years, so we can deal with complaints and claims.
        </li>
      </ul>
      <p>After these periods we delete or anonymise the information.</p>

      <h2>Your rights</h2>
      <p>You can ask us to:</p>
      <ul>
        <li>give you a copy of the information we hold about you;</li>
        <li>correct anything that is wrong;</li>
        <li>delete your information;</li>
        <li>restrict how we use it, or object to our use of it;</li>
        <li>give you your information in a portable format, where that right applies.</li>
      </ul>
      <p>
        You can <strong>withdraw your consent at any time</strong> by emailing{" "}
        <a href={`mailto:${brand.privacyEmail}`}>{brand.privacyEmail}</a> with your enquiry reference. We will tell the electrical
        business to stop contacting you and delete your details, although we cannot undo contact that has already happened.
        Withdrawing consent does not affect what we did before you withdrew it. We aim to respond within one month.
      </p>

      <h2>Complaints</h2>
      <p>
        If you are unhappy with how we use your information, please tell us first so we can put it right. You can also complain to
        the Information Commissioner&apos;s Office at <a href="https://ico.org.uk/make-a-complaint/">ico.org.uk/make-a-complaint</a>{" "}
        or on 0303 123 1113.
      </p>

      <h2>Cookies and similar technologies</h2>
      <p>
        This page does not use advertising or analytics cookies. While you fill in the form, your browser temporarily keeps your
        answers in its session storage so a refresh does not lose them; this is cleared when you close the tab or send your
        enquiry. Cloudflare Turnstile runs a short check in your browser to detect automated programs.
      </p>

      <h2>Changes to this notice</h2>
      <p>We will update this page if we change how we use your information. Version 1.</p>
    </LegalPage>
  );
}
