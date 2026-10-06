import type { Metadata } from "next";
import { getBrand } from "@/config/brand";
import { LegalPage } from "@/components/landing/LegalPage";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "The terms on which you may use this website to ask for electrician quotes.",
};

export default function TermsPage() {
  const brand = getBrand();
  return (
    <LegalPage title="Terms of use">
      <p>
        These terms apply when you use this website, operated by {brand.legalName} (company number {brand.companyNumber}), to ask
        for electrician quotes.
      </p>

      <h2>What we do</h2>
      <p>
        {brand.name} is an introduction service. When you send an enquiry we pass it to an electrical business that covers your area.
        We are not an electrical company, we do not carry out electrical work, and we are not a party to any agreement between you and a
        electrical business.
      </p>

      <h2>Using the service</h2>
      <ul>
        <li>The service is free for you to use.</li>
        <li>Please give accurate details and only submit enquiries about property you are entitled to ask work to be done on.</li>
        <li>You are never obliged to accept a quote or to use the electrical business we introduce.</li>
        <li>
          We cannot guarantee that an electrical business will contact you, or how quickly, or that you will agree a price.
        </li>
      </ul>

      <h2>Electrical businesses</h2>
      <p>
        Electrical businesses are independent. Any quote, contract, guarantee or insurance is between you and that business. Please
        check a business&apos;s credentials, insurance and references before agreeing work. For notifiable electrical work, ask whether the electrician is registered with a competent person scheme, and ask for the electrical certificate when the job is finished.
      </p>

      <h2>Our responsibility</h2>
      <p>
        We take reasonable care in running this website, but we do not accept responsibility for the work, advice or conduct of
        electrical businesses. Nothing in these terms limits any liability that cannot be limited by law, including your statutory
        consumer rights.
      </p>

      <h2>Law</h2>
      <p>These terms are governed by the law of England and Wales.</p>

      <h2>Contact</h2>
      <p>
        {brand.legalName}, {brand.registeredAddress}. Privacy questions: <a href={`mailto:${brand.privacyEmail}`}>{brand.privacyEmail}</a>.
      </p>
    </LegalPage>
  );
}
