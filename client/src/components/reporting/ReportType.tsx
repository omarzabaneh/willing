type ReportTypeProps = {
  title: string;
  size?: 'md' | 'lg';
  className?: string;
};

const formatReportType = (title: string) => title
  .replaceAll('_', ' ')
  .replace(/^./, firstLetter => firstLetter.toUpperCase());

function ReportType({ title, size = 'md', className = '' }: ReportTypeProps) {
  const sizeClassName = size === 'lg' ? 'badge-lg' : '';

  return (
    <span className={`badge badge-error badge-outline h-auto whitespace-normal text-center ${sizeClassName} ${className}`.trim()}>
      {formatReportType(title)}
    </span>
  );
}

export default ReportType;
